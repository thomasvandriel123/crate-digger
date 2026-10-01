import { colourBin } from './colour';
import { compareText, filingKey, fold } from './text';
import { ALBUM_TYPES } from './types';
import type { Album, AlbumType, GenreGroup, Library, Palette, Track } from './types';

/**
 * Turns library.json (schema version 1) into the viewer's normalised model.
 *
 * Tolerant by design: the ingest may run against an API that dropped fields, so anything optional can be
 * missing or null. Albums without an id are skipped; everything else degrades to a sensible default.
 */

type Json = Record<string, unknown>;

const FALLBACK_PALETTE: Palette = {
  dominant: '#5e3a22',
  swatches: ['#5e3a22', '#2b1f1a', '#d9cfbd'],
  hue: 50,
  chroma: 0.05,
  lightness: 0.35,
  mono: false,
};

export class LibraryError extends Error {}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function parsePalette(v: unknown): Palette {
  if (!v || typeof v !== 'object') return FALLBACK_PALETTE;
  const p = v as Json;
  const dominant = str(p.dominant);
  if (!dominant || !/^#[0-9a-f]{6}$/i.test(dominant)) return FALLBACK_PALETTE;
  const swatches = strings(p.swatches).filter((s) => /^#[0-9a-f]{6}$/i.test(s));
  return {
    dominant: dominant.toLowerCase(),
    swatches: swatches.length > 0 ? swatches : [dominant],
    hue: num(p.hue) ?? 0,
    chroma: num(p.chroma) ?? 0,
    lightness: num(p.lightness) ?? 0.5,
    mono: p.mono === true,
  };
}

function parseTracks(v: unknown): Track[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const tracks: Track[] = [];
  v.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const o = t as Json;
    const track: Track = { n: num(o.n) ?? i + 1, title: str(o.title) ?? 'Untitled', durationMs: num(o.durationMs) ?? 0 };
    const uri = str(o.uri);
    if (uri) track.uri = uri;
    tracks.push(track);
  });
  return tracks.length > 0 ? tracks : null;
}

function parseAddedAt(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function normaliseAlbum(raw: unknown, index: number): Album | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Json;
  const id = str(o.id);
  if (!id) return null;
  const artists = (Array.isArray(o.artists) ? o.artists : [])
    .map((a) => (a && typeof a === 'object' ? { id: str((a as Json).id) ?? '', name: str((a as Json).name) ?? '' } : null))
    .filter((a): a is { id: string; name: string } => !!a && a.name.length > 0);
  if (artists.length === 0) artists.push({ id: '', name: 'Unknown artist' });
  const title = str(o.title) ?? 'Untitled';
  const typeRaw = str(o.type);
  const type: AlbumType = ALBUM_TYPES.includes(typeRaw as AlbumType) ? (typeRaw as AlbumType) : 'album';
  const cover = (o.cover && typeof o.cover === 'object' ? o.cover : {}) as Json;
  const palette = parsePalette(o.palette);
  const tracks = parseTracks(o.tracks);
  const durationFromTracks = tracks ? tracks.reduce((s, t) => s + t.durationMs, 0) : null;
  const year = num(o.year);
  return {
    id,
    uri: str(o.uri) ?? `spotify:album:${id}`,
    title,
    artists,
    artist: artists.map((a) => a.name).join(' & '),
    sortArtist: filingKey(artists[0]!.name),
    sortTitle: filingKey(title),
    year: year !== null && year > 1000 && year < 3000 ? Math.round(year) : null,
    releaseDate: str(o.releaseDate),
    addedAt: parseAddedAt(o.addedAt),
    type,
    label: str(o.label)?.trim() ?? null,
    totalTracks: num(o.totalTracks) ?? tracks?.length ?? null,
    durationMs: num(o.durationMs) ?? durationFromTracks,
    genres: strings(o.genres),
    genresRaw: strings(o.genresRaw).map((g) => g.toLowerCase()),
    cover: {
      web: str(cover.web) ?? `covers/512/${id}.webp`,
      thumb: str(cover.thumb) ?? str(cover.web) ?? `covers/256/${id}.webp`,
      ktx2: str(cover.ktx2),
    },
    palette,
    colour: colourBin(palette),
    tracks,
    tracksRef: str(o.tracksRef),
    index,
  };
}

const MACRO_NAMES: Record<string, string> = {
  rock: 'Rock',
  pop: 'Pop',
  jazz: 'Jazz',
  soul: 'Soul & R&B',
  hiphop: 'Hip-Hop',
  electronic: 'Electronic',
  folk: 'Folk & Country',
  blues: 'Blues',
  classical: 'Classical',
  reggae: 'Reggae & Dub',
  latin: 'Latin',
  world: 'World',
  metal: 'Metal',
  punk: 'Punk & Hardcore',
  soundtrack: 'Soundtrack',
  ambient: 'Ambient & Experimental',
};

function parseTaxonomy(v: unknown, albums: Album[]): GenreGroup[] {
  const present = new Set(albums.flatMap((a) => a.genres));
  if (Array.isArray(v) && v.length > 0) {
    const groups: GenreGroup[] = [];
    for (const g of v) {
      if (!g || typeof g !== 'object') continue;
      const o = g as Json;
      const id = str(o.id);
      if (!id || !present.has(id)) continue;
      groups.push({ id, name: str(o.name) ?? MACRO_NAMES[id] ?? id, micro: strings(o.micro).map((m) => m.toLowerCase()) });
    }
    if (groups.length > 0) return groups;
  }
  // Older or hand-made libraries: derive micro genres by co-occurrence on albums.
  const micro = new Map<string, Set<string>>();
  for (const a of albums) {
    for (const g of a.genres) {
      const set = micro.get(g) ?? new Set<string>();
      a.genresRaw.forEach((r) => set.add(r));
      micro.set(g, set);
    }
  }
  return [...micro.keys()]
    .sort((a, b) => compareText(MACRO_NAMES[a] ?? a, MACRO_NAMES[b] ?? b))
    .map((id) => ({ id, name: MACRO_NAMES[id] ?? id, micro: [...(micro.get(id) ?? [])].sort() }));
}

export function normaliseLibrary(json: unknown): Library {
  if (!json || typeof json !== 'object') throw new LibraryError('library.json is not an object');
  const o = json as Json;
  const version = num(o.version) ?? 1;
  if (version > 1) {
    console.warn(`library.json version ${version} is newer than this viewer understands (1); reading what it can`);
  }
  if (!Array.isArray(o.albums)) throw new LibraryError('library.json has no albums array');
  const seen = new Set<string>();
  const albums: Album[] = [];
  o.albums.forEach((raw, i) => {
    const album = normaliseAlbum(raw, i);
    if (album && !seen.has(album.id)) {
      seen.add(album.id);
      albums.push({ ...album, index: albums.length });
    }
  });
  const viewer = o.viewer && typeof o.viewer === 'object' ? (o.viewer as Json) : {};
  const capacity = num(viewer.crateCapacity);
  const labels = [...new Set(albums.map((a) => a.label).filter((l): l is string => !!l))].sort(compareText);
  const years = albums.map((a) => a.year).filter((y): y is number => y !== null);
  return {
    version,
    generatedAt: str(o.generatedAt),
    source: str(o.source) ?? 'unknown',
    albums,
    byId: new Map(albums.map((a) => [a.id, a])),
    taxonomy: parseTaxonomy(o.taxonomy, albums),
    labels,
    yearRange: years.length > 0 ? [Math.min(...years), Math.max(...years)] : null,
    capabilities: {
      label: labels.length > 0,
      added: albums.some((a) => a.addedAt !== null),
      genres: albums.some((a) => a.genres.length > 0),
      year: years.length > 0,
      tracks: albums.some((a) => a.tracks !== null || a.tracksRef !== null),
    },
    crateCapacity: capacity !== null && Number.isInteger(capacity) && capacity > 0 ? capacity : null,
  };
}

/** Lowercased haystack used by search; kept here so the fields searched are defined in one place. */
export function searchText(album: Album): string {
  return fold(`${album.artist} ${album.title} ${album.label ?? ''}`);
}
