/**
 * Builds the viewer's library live from the connected Spotify account: every saved album (and nothing
 * else), in the library.json schema, so the room cannot tell it from a built library.
 *
 * - First visit: page through /me/albums, compute cover palettes in the browser, show the room.
 * - Later visits: show the cached copy at once, then check cheaply (newest saved album + total) whether it
 *   is still current and rebuild in the background if not, reusing palettes already computed.
 * - Genres come from the album's artists (one request per artist; the batch endpoint is gone for
 *   development-mode apps), fetched in the background and cached for 30 days.
 */

import type { Palette } from '../data/types';
import type { SpotifyApi } from './api';
import type { GenreMap } from './genres';
import { mapSavedAlbum, mapTracks, NEUTRAL_PALETTE } from './mapping';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type RawAlbum = Record<string, unknown> & {
  id: string;
  artists: { id: string; name: string }[];
  genres: string[];
  genresRaw: string[];
  palette: Palette;
  tracks: unknown[] | null;
};

export interface RawLibrary {
  version: 1;
  generatedAt: string;
  source: 'spotify';
  albums: RawAlbum[];
  taxonomy: { id: string; name: string; micro: string[] }[];
}

interface CachedLibrary {
  /** Format of this cache entry; bump to drop old caches. */
  v: 1;
  newestId: string | null;
  total: number;
  library: RawLibrary;
}

export interface Progress {
  phase: 'albums' | 'covers';
  done: number;
  total: number;
}

export const LIBRARY_KEY = 'crate-digger:spotify-library';
export const GENRES_KEY = 'crate-digger:spotify-artist-genres';
const GENRE_TTL_MS = 30 * 24 * 3600 * 1000;
const PALETTE_CONCURRENCY = 8;
const ARTIST_CONCURRENCY = 3;

export interface LoaderDeps {
  api: SpotifyApi;
  storage: KV;
  genres: GenreMap;
  palette: (url: string) => Promise<Palette | null>;
  now: () => number;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class SpotifyLibraryLoader {
  constructor(private deps: LoaderDeps) {}

  /** The library from the last visit, if any. */
  cached(): CachedLibrary | null {
    try {
      const raw = this.deps.storage.getItem(LIBRARY_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw) as CachedLibrary;
      return c?.v === 1 && Array.isArray(c.library?.albums) ? c : null;
    } catch {
      return null;
    }
  }

  private saveCache(entry: CachedLibrary): void {
    const write = (value: CachedLibrary) => this.deps.storage.setItem(LIBRARY_KEY, JSON.stringify(value));
    try {
      write(entry);
    } catch {
      // Over quota: drop track lists (they are fetched per album when needed) and try once more.
      try {
        write({
          ...entry,
          library: { ...entry.library, albums: entry.library.albums.map((a) => ({ ...a, tracks: null })) },
        });
      } catch {
        /* no cache this time; the next visit loads from Spotify again */
      }
    }
  }

  clear(): void {
    for (const key of [LIBRARY_KEY, GENRES_KEY]) {
      try {
        this.deps.storage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }

  /** True when the cached copy no longer matches the account (an album was saved or removed). */
  async isStale(cached: CachedLibrary): Promise<boolean> {
    const head = await this.deps.api.newestSaved();
    return head.id !== cached.newestId || head.total !== cached.total;
  }

  /** Fetch every saved album and build the library. Palettes already known (by album id) are reused. */
  async build(onProgress?: (p: Progress) => void, previous?: RawLibrary | null): Promise<RawLibrary> {
    const { api } = this.deps;
    const items = await api.savedAlbums((done, total) => onProgress?.({ phase: 'albums', done, total }));
    const known = new Map((previous?.albums ?? []).map((a) => [a.id, a]));
    const mapped = items.map((it) => mapSavedAlbum(it, null)).filter((m) => m !== null);

    // Albums with more than 50 tracks list the rest on further pages.
    await pool(
      mapped.filter((m) => m.moreTracks),
      4,
      async (m) => {
        try {
          const more = mapTracks(await api.remainingTracks(m.moreTracks!));
          const tracks = [...((m.record.tracks as unknown[] | null) ?? []), ...more] as {
            durationMs: number;
          }[];
          m.record.tracks = tracks;
          m.record.durationMs = tracks.reduce((s, t) => s + t.durationMs, 0);
        } catch {
          /* keep the first page; the duration is then a lower bound */
        }
      },
    );

    const todo = mapped.filter((m) => !known.has(m.record.id as string) && m.paletteImage);
    let done = 0;
    onProgress?.({ phase: 'covers', done, total: todo.length });
    await pool(todo, PALETTE_CONCURRENCY, async (m) => {
      m.record.palette = (await this.deps.palette(m.paletteImage!)) ?? NEUTRAL_PALETTE;
      onProgress?.({ phase: 'covers', done: ++done, total: todo.length });
    });

    const albums = mapped.map((m) => {
      const record = m.record as RawAlbum;
      const prev = known.get(record.id);
      if (prev) record.palette = prev.palette;
      return record;
    });
    const library = this.withGenres({
      version: 1,
      generatedAt: new Date(this.deps.now()).toISOString(),
      source: 'spotify',
      albums,
      taxonomy: [],
    });
    this.saveCache({ v: 1, newestId: albums[0]?.id ?? null, total: items.length, library });
    return library;
  }

  // --- genres ------------------------------------------------------------------------------------------

  private genreCache(): Record<string, { genres: string[]; at: number }> {
    try {
      const raw = this.deps.storage.getItem(GENRES_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, { genres: string[]; at: number }>)
        : {};
    } catch {
      return {};
    }
  }

  /** Apply cached artist genres and the genre map to a library (no network). */
  withGenres(library: RawLibrary, cache = this.genreCache()): RawLibrary {
    const gm = this.deps.genres;
    const albums = library.albums.map((a) => {
      const raw = new Set(a.genresRaw);
      for (const ar of a.artists) cache[ar.id]?.genres.forEach((g) => raw.add(g.toLowerCase()));
      const genresRaw = [...raw].sort();
      return { ...a, genresRaw, genres: gm.mapMany(genresRaw) };
    });
    return { ...library, albums, taxonomy: gm.taxonomy(albums) };
  }

  /**
   * Fetch genres for artists not cached (or stale), then return the library with genres applied, or null
   * if nothing new was learned. Failures are skipped: genres are a nicety, never a blocker.
   */
  async enrichGenres(library: RawLibrary, signal?: AbortSignal): Promise<RawLibrary | null> {
    const cache = this.genreCache();
    const now = this.deps.now();
    const ids = [...new Set(library.albums.flatMap((a) => a.artists.map((ar) => ar.id)).filter(Boolean))];
    const missing = ids.filter((id) => !cache[id] || now - cache[id].at > GENRE_TTL_MS);
    if (missing.length === 0) return null;
    let learned = 0;
    let failures = 0;
    await pool(missing, ARTIST_CONCURRENCY, async (id) => {
      if (signal?.aborted || failures > 5) return;
      try {
        const genres = await this.deps.api.artistGenres(id);
        cache[id] = { genres, at: now };
        learned++;
      } catch {
        failures++;
      }
    });
    if (learned === 0) return null;
    try {
      this.deps.storage.setItem(GENRES_KEY, JSON.stringify(cache));
    } catch {
      /* the genres still apply for this visit */
    }
    const enriched = this.withGenres(library, cache);
    const cached = this.cached();
    if (cached) this.saveCache({ ...cached, library: enriched });
    return enriched;
  }
}
