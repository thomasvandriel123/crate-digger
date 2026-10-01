/** Shapes shared by the pure data layer. No three.js, no DOM. */

export type AlbumType = 'album' | 'single' | 'compilation';

export const ALBUM_TYPES: readonly AlbumType[] = ['album', 'single', 'compilation'];

export interface Track {
  n: number;
  title: string;
  durationMs: number;
  /** Spotify track URI when known (live Spotify libraries), used to follow playback progress. */
  uri?: string;
}

export interface Palette {
  dominant: string;
  swatches: string[];
  /** OKLCH hue in degrees, [0, 360). */
  hue: number;
  chroma: number;
  lightness: number;
  mono: boolean;
}

export interface Artist {
  id: string;
  name: string;
}

/** Colour filter bins: ten OKLCH hue sectors plus black-and-white. */
export type ColourBin =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'lime'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'violet'
  | 'pink'
  | 'mono';

/** A normalised album as the viewer uses it. Built once from library.json by `normaliseLibrary`. */
export interface Album {
  id: string;
  uri: string;
  title: string;
  artists: Artist[];
  /** Display string, e.g. "Mira Okafor & Joon". */
  artist: string;
  /** Record-shop filing key: lowercased, accents folded, leading "The " dropped. */
  sortArtist: string;
  sortTitle: string;
  year: number | null;
  releaseDate: string | null;
  /** Epoch milliseconds, or null when the source has no date (e.g. data export). */
  addedAt: number | null;
  type: AlbumType;
  label: string | null;
  totalTracks: number | null;
  durationMs: number | null;
  genres: string[];
  genresRaw: string[];
  cover: { web: string; thumb: string; ktx2: string | null };
  palette: Palette;
  colour: ColourBin;
  tracks: Track[] | null;
  tracksRef: string | null;
  /** Position in library.json (newest added first); a stable tiebreaker for every sort. */
  index: number;
}

export interface GenreGroup {
  id: string;
  name: string;
  micro: string[];
}

export interface LibraryCapabilities {
  /** False when no album has a label (Spotify removed the field): the Label filter is hidden, not faked. */
  label: boolean;
  added: boolean;
  genres: boolean;
  year: boolean;
  tracks: boolean;
}

export interface Library {
  version: number;
  generatedAt: string | null;
  source: string;
  albums: Album[];
  byId: Map<string, Album>;
  taxonomy: GenreGroup[];
  labels: string[];
  yearRange: [number, number] | null;
  capabilities: LibraryCapabilities;
  /** Optional viewer setting from library.json (`viewer.crateCapacity`, set by `ingest.run --crate-size`). */
  crateCapacity: number | null;
}

export type SortMode = 'artist' | 'title' | 'year' | 'added' | 'colour' | 'random';
export type SortDir = 'asc' | 'desc';

export interface SortState {
  mode: SortMode;
  dir: SortDir;
  /** Seed for "Dig at random"; re-roll picks a new one. */
  seed: number;
}

export type AddedPreset = 'month' | 'year' | 'pre2020';

export type AddedFilter = { preset: AddedPreset } | { from: string | null; to: string | null };

export interface FilterState {
  genres: string[];
  styles: string[];
  year: [number, number] | null;
  colours: ColourBin[];
  added: AddedFilter | null;
  labels: string[];
  types: AlbumType[];
  search: string;
}

export interface Divider {
  label: string;
  /** Record index inside the crate that this divider stands in front of. */
  at: number;
}

export interface Crate {
  /** Stable-ish identity: the first album id. Used to keep crate objects across re-shelves. */
  key: string;
  index: number;
  records: string[];
  dividers: Divider[];
  label: string;
}

export interface Slot {
  crate: number;
  index: number;
}

export interface Layout {
  crates: Crate[];
  order: string[];
  slots: Map<string, Slot>;
  matched: number;
  total: number;
  /** Changes whenever the derived arrangement changes; cheap equality for subscribers. */
  signature: string;
}
