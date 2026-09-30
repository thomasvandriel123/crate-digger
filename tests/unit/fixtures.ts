import { normaliseLibrary } from '../../src/data/library';
import type { Library } from '../../src/data/types';

let n = 0;

export interface RawAlbumInput {
  id?: string;
  title?: string;
  artist?: string;
  year?: number | null;
  addedAt?: string | null;
  type?: string;
  label?: string | null;
  genres?: string[];
  genresRaw?: string[];
  hue?: number;
  chroma?: number;
  lightness?: number;
  mono?: boolean;
  tracks?: { n: number; title: string; durationMs: number }[] | null;
}

export function rawAlbum(input: RawAlbumInput = {}): Record<string, unknown> {
  n++;
  const id = input.id ?? `album${String(n).padStart(4, '0')}`;
  return {
    id,
    uri: `spotify:album:${id}`,
    title: input.title ?? `Title ${n}`,
    artists: [{ id: `artist-${input.artist ?? n}`, name: input.artist ?? `Artist ${n}` }],
    year: input.year === undefined ? 1970 : input.year,
    releaseDate: input.year ? `${input.year}-01-01` : null,
    addedAt: input.addedAt === undefined ? '2024-01-01T00:00:00Z' : input.addedAt,
    type: input.type ?? 'album',
    label: input.label === undefined ? 'Label' : input.label,
    totalTracks: 1,
    durationMs: 1000,
    genres: input.genres ?? [],
    genresRaw: input.genresRaw ?? [],
    cover: { web: `covers/512/${id}.webp`, thumb: `covers/256/${id}.webp`, ktx2: null },
    palette: {
      dominant: '#884422',
      swatches: ['#884422'],
      hue: input.hue ?? 40,
      chroma: input.chroma ?? 0.1,
      lightness: input.lightness ?? 0.5,
      mono: input.mono ?? false,
    },
    tracks: input.tracks === undefined ? [{ n: 1, title: 'One', durationMs: 1000 }] : input.tracks,
  };
}

export function library(albums: RawAlbumInput[], extra: Record<string, unknown> = {}): Library {
  return normaliseLibrary({
    version: 1,
    generatedAt: '2024-01-01T00:00:00Z',
    albums: albums.map(rawAlbum),
    ...extra,
  });
}
