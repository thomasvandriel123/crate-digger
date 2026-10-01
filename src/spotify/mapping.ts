/**
 * Spotify saved-album objects -> library.json album records (the same schema the ingest writes), so the
 * rest of the viewer cannot tell a live Spotify library from a built one. Pure; tolerant of missing fields.
 */

import type { Palette } from '../data/types';
import type { SavedAlbumItem, SpotifyImage, SpotifyTrack } from './api';

export interface MappedAlbum {
  record: Record<string, unknown>;
  /** Small image used to compute the cover palette in the browser. */
  paletteImage: string | null;
  /** Tracks beyond the first page, to fetch separately. */
  moreTracks: string | null;
}

export function pickImage(images: SpotifyImage[] | undefined, target: number): string | null {
  const list = (images ?? []).filter((i) => i?.url);
  if (list.length === 0) return null;
  const size = (i: SpotifyImage) => i.width ?? i.height ?? 0;
  // The smallest image at least `target` wide, else the largest available.
  const big = list.filter((i) => size(i) >= target).sort((a, b) => size(a) - size(b));
  return (big[0] ?? [...list].sort((a, b) => size(b) - size(a))[0]!).url;
}

function year(date: string | undefined): number | null {
  const m = /^(\d{4})/.exec(date ?? '');
  if (!m) return null;
  const y = Number(m[1]);
  return y > 1000 ? y : null;
}

export function mapTracks(
  items: SpotifyTrack[],
): { n: number; title: string; durationMs: number; uri?: string }[] {
  return items.filter(Boolean).map((t, i) => ({
    n: t.track_number ?? i + 1,
    title: t.name ?? 'Untitled',
    durationMs: t.duration_ms ?? 0,
    ...(t.uri ? { uri: t.uri } : {}),
  }));
}

export function mapSavedAlbum(item: SavedAlbumItem, palette: Palette | null): MappedAlbum | null {
  const a = item.album;
  if (!a?.id) return null;
  const tracks = mapTracks(a.tracks?.items ?? []);
  const type =
    a.album_type === 'compilation'
      ? 'compilation'
      : a.album_type === 'single' || a.album_type === 'ep'
        ? 'single'
        : 'album';
  const artists = (a.artists ?? []).filter((x) => x?.name).map((x) => ({ id: x.id ?? '', name: x.name! }));
  return {
    record: {
      id: a.id,
      uri: a.uri ?? `spotify:album:${a.id}`,
      title: a.name ?? 'Untitled',
      artists: artists.length ? artists : [{ id: '', name: 'Unknown artist' }],
      year: year(a.release_date),
      releaseDate: a.release_date ?? null,
      addedAt: item.added_at ?? null,
      type,
      // Removed from development-mode responses in 2026; kept when present.
      label: a.label?.trim() || null,
      totalTracks: a.total_tracks ?? tracks.length,
      durationMs: tracks.length ? tracks.reduce((s, t) => s + t.durationMs, 0) : null,
      genres: [],
      genresRaw: (a.genres ?? []).map((g) => g.toLowerCase()),
      cover: { web: pickImage(a.images, 600), thumb: pickImage(a.images, 280), ktx2: null },
      palette: palette ?? NEUTRAL_PALETTE,
      tracks: tracks.length ? tracks : null,
    },
    paletteImage: pickImage(a.images, 60),
    moreTracks: a.tracks?.next ?? null,
  };
}

/** Placeholder until a cover's colours are known: the sleeve-board brown of the room. */
export const NEUTRAL_PALETTE: Palette = {
  dominant: '#6b4a34',
  swatches: ['#6b4a34', '#2b1f1a', '#d9cfbd'],
  hue: 55,
  chroma: 0.05,
  lightness: 0.42,
  mono: false,
};
