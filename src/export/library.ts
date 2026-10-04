/**
 * A library built from an uploaded Spotify export, enriched in the background from MusicBrainz (year,
 * type, genres) and the Cover Art Archive (covers, palettes). Everything is kept in the visitor's browser:
 * the album list, and a per-album cache so a reload, or a new export next month, only looks up what is new.
 */

import type { Palette } from '../data/types';
import type { GenreMap } from '../spotify/genres';
import { NEUTRAL_PALETTE } from '../spotify/mapping';
import { coverUrls, MbAbort, type MbMatch, type MbTracks, type MusicBrainz } from './musicbrainz';
import type { ExportAlbum } from './parse';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const ALBUMS_KEY = 'crate-digger:export-albums';
export const CACHE_KEY = 'crate-digger:mb-albums';
export const TRACKS_KEY = 'crate-digger:mb-tracks';
/** Marks a cover to be drawn in the browser (no artwork known). */
export const GENERATED_COVER = 'generated:';
const RECHECK_MISS_MS = 30 * 24 * 3600 * 1000;

export interface CacheEntry {
  m: MbMatch | null;
  /** True once a cover image was fetched and sampled; false when the archive has none. */
  cover?: boolean;
  palette?: Palette | null;
  at: number;
}

export interface StoredExport {
  v: 1;
  importedAt: string;
  albums: ExportAlbum[];
}

export interface EnrichProgress {
  done: number;
  total: number;
  found: number;
  /** Albums still to look up, at about one per second. */
  remaining: number;
}

export interface RawExportLibrary {
  version: 1;
  generatedAt: string;
  source: 'export';
  albums: Record<string, unknown>[];
  taxonomy: { id: string; name: string; micro: string[] }[];
}

function readJson<T>(kv: KV, key: string, fallback: T): T {
  try {
    const raw = kv.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(kv: KV, key: string, value: unknown): void {
  try {
    kv.setItem(key, JSON.stringify(value));
  } catch {
    /* over quota or blocked: works for this visit, re-looked-up next time */
  }
}

export interface ExportLibraryDeps {
  storage: KV;
  mb: MusicBrainz;
  genres: GenreMap;
  palette: (url: string) => Promise<Palette | null>;
  now: () => number;
}

export class ExportLibrary {
  private cache: Record<string, CacheEntry>;
  private trackCache: Record<string, MbTracks>;

  constructor(private deps: ExportLibraryDeps) {
    this.cache = readJson(deps.storage, CACHE_KEY, {});
    this.trackCache = readJson(deps.storage, TRACKS_KEY, {});
  }

  stored(): StoredExport | null {
    const s = readJson<StoredExport | null>(this.deps.storage, ALBUMS_KEY, null);
    return s?.v === 1 && Array.isArray(s.albums) && s.albums.length > 0 ? s : null;
  }

  save(albums: ExportAlbum[]): StoredExport {
    const s: StoredExport = { v: 1, importedAt: new Date(this.deps.now()).toISOString(), albums };
    writeJson(this.deps.storage, ALBUMS_KEY, s);
    return s;
  }

  /** Forget the upload and everything looked up for it. */
  clear(): void {
    for (const key of [ALBUMS_KEY, CACHE_KEY, TRACKS_KEY]) {
      try {
        this.deps.storage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    this.cache = {};
    this.trackCache = {};
  }

  private persist(): void {
    writeJson(this.deps.storage, CACHE_KEY, this.cache);
  }

  /** Albums that still need a MusicBrainz lookup (never looked up, or a miss old enough to retry). */
  todo(albums: readonly ExportAlbum[]): ExportAlbum[] {
    const now = this.deps.now();
    return albums.filter((a) => {
      const c = this.cache[a.id];
      return !c || (c.m === null && now - c.at > RECHECK_MISS_MS);
    });
  }

  progress(albums: readonly ExportAlbum[]): EnrichProgress {
    const todo = this.todo(albums).length;
    return {
      done: albums.length - todo,
      total: albums.length,
      found: albums.filter((a) => this.cache[a.id]?.m).length,
      remaining: todo,
    };
  }

  /** The library.json-shaped library for these albums, with whatever is known so far. */
  build(albums: readonly ExportAlbum[]): RawExportLibrary {
    const gm = this.deps.genres;
    const records = albums.map((a) => {
      const c = this.cache[a.id];
      const m = c?.m ?? null;
      const t = m ? this.trackCache[m.rg] : undefined;
      const year = m?.date ? Number(m.date.slice(0, 4)) : null;
      const genresRaw = [...new Set(m?.tags ?? [])].sort();
      const tracks = t?.tracks.length ? t.tracks : null;
      const covers = m && c?.cover ? coverUrls(m.rg) : { web: GENERATED_COVER, thumb: GENERATED_COVER };
      return {
        id: a.id,
        uri: a.uri,
        title: a.title,
        artists: [{ id: '', name: a.artist }],
        year: year && year > 1000 ? year : null,
        releaseDate: m?.date ?? null,
        addedAt: null,
        type: m?.type ?? 'album',
        label: t?.label ?? null,
        totalTracks: tracks?.length ?? null,
        durationMs: tracks ? tracks.reduce((s, x) => s + x.durationMs, 0) || null : null,
        genres: gm.mapMany(genresRaw),
        genresRaw,
        cover: { ...covers, ktx2: null },
        palette: c?.palette ?? NEUTRAL_PALETTE,
        tracks,
      };
    });
    return {
      version: 1,
      generatedAt: new Date(this.deps.now()).toISOString(),
      source: 'export',
      albums: records,
      taxonomy: gm.taxonomy(records),
    };
  }

  /** Look one album up (and sample its cover). Priority 0 jumps the background queue. */
  async lookup(a: ExportAlbum, priority = 10, signal?: AbortSignal): Promise<CacheEntry> {
    const m = await this.deps.mb.findAlbum(a.artist, a.title, priority, signal);
    const entry: CacheEntry = { m, at: this.deps.now() };
    if (m) {
      // The cover's palette doubles as the check that the archive has a front cover at all.
      const palette = await this.deps.palette(coverUrls(m.rg).thumb);
      entry.cover = palette !== null;
      entry.palette = palette;
    }
    this.cache[a.id] = entry;
    return entry;
  }

  /** Track list (and label) for a held record; looks the album up first if the background job has not. */
  async tracks(a: ExportAlbum): Promise<MbTracks | null> {
    let c = this.cache[a.id];
    if (!c) {
      c = await this.lookup(a, 0);
      this.persist();
    }
    if (!c.m) return null;
    const known = this.trackCache[c.m.rg];
    if (known) return known;
    const t = await this.deps.mb.tracks(c.m.rg, 0);
    if (t) {
      this.trackCache[c.m.rg] = t;
      writeJson(this.deps.storage, TRACKS_KEY, this.trackCache);
    }
    return t;
  }

  /**
   * Work through every album not looked up yet, about one per second. `onUpdate` fires every
   * `updateEvery` albums (and at the end) so the room can refile records as their years, genres and
   * covers arrive. Stops quietly when `signal` aborts; pauses after repeated network failures.
   */
  async enrich(
    albums: readonly ExportAlbum[],
    opts: {
      signal?: AbortSignal;
      onProgress?: (p: EnrichProgress) => void;
      onUpdate?: () => void;
      updateEvery?: number;
    } = {},
  ): Promise<'done' | 'aborted' | 'offline'> {
    const todo = this.todo(albums);
    let sinceUpdate = 0;
    let failures = 0;
    opts.onProgress?.(this.progress(albums));
    for (const a of todo) {
      if (opts.signal?.aborted) break;
      if (this.cache[a.id] && this.todo([a]).length === 0) continue; // looked up on demand meanwhile
      try {
        await this.lookup(a, 10, opts.signal);
        failures = 0;
      } catch (err) {
        if (err instanceof MbAbort || opts.signal?.aborted) break;
        if (++failures >= 5) {
          this.persist();
          opts.onUpdate?.();
          return 'offline';
        }
        continue;
      }
      opts.onProgress?.(this.progress(albums));
      if (++sinceUpdate >= (opts.updateEvery ?? 20)) {
        sinceUpdate = 0;
        this.persist();
        opts.onUpdate?.();
      }
    }
    this.persist();
    opts.onUpdate?.();
    return opts.signal?.aborted ? 'aborted' : 'done';
  }
}
