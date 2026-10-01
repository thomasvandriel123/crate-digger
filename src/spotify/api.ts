/**
 * Minimal Spotify Web API client for the browser: bearer auth with refresh on 401, Retry-After on 429,
 * bounded retries on 5xx, and paging. Only the endpoints the viewer needs.
 */

import type { SpotifyAuth } from './auth';

export const API = 'https://api.spotify.com/v1';

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyTrack {
  id?: string;
  uri?: string;
  name?: string;
  track_number?: number;
  duration_ms?: number;
}

export interface SpotifyAlbum {
  id: string;
  uri?: string;
  name?: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  label?: string;
  genres?: string[];
  artists?: { id?: string; name?: string }[];
  images?: SpotifyImage[];
  tracks?: { items?: SpotifyTrack[]; next?: string | null };
}

export interface SavedAlbumItem {
  added_at?: string;
  album?: SpotifyAlbum;
}

interface Page<T> {
  items?: T[];
  next?: string | null;
  total?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SpotifyApi {
  constructor(
    private auth: SpotifyAuth,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
    private wait: (ms: number) => Promise<unknown> = sleep,
  ) {}

  async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T | null> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.accessToken();
      const res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 204) return null;
      if (res.ok) {
        const text = await res.text();
        return text ? (JSON.parse(text) as T) : null;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.auth.refresh();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const after = Number(res.headers.get('Retry-After'));
        await this.wait(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
        continue;
      }
      let message = `Spotify ${method} ${new URL(url).pathname} failed (HTTP ${res.status})`;
      try {
        const j = (await res.json()) as { error?: { message?: string; reason?: string } };
        if (j.error?.message) message = `${message}: ${j.error.message}`;
      } catch {
        /* keep generic message */
      }
      throw new SpotifyApiError(message, res.status);
    }
  }

  get<T>(pathOrUrl: string): Promise<T | null> {
    return this.request<T>('GET', pathOrUrl);
  }

  /** Every saved album, newest first. `onPage` reports progress as (loaded, total). */
  async savedAlbums(onPage?: (loaded: number, total: number) => void): Promise<SavedAlbumItem[]> {
    const items: SavedAlbumItem[] = [];
    let next: string | null = '/me/albums?limit=50';
    while (next) {
      const page: Page<SavedAlbumItem> | null = await this.get<Page<SavedAlbumItem>>(next);
      items.push(...(page?.items ?? []));
      onPage?.(items.length, page?.total ?? items.length);
      next = page?.next ?? null;
    }
    return items;
  }

  /** Remaining track pages for albums with more than 50 tracks. */
  async remainingTracks(next: string): Promise<SpotifyTrack[]> {
    const out: SpotifyTrack[] = [];
    let url: string | null = next;
    while (url) {
      const page: Page<SpotifyTrack> | null = await this.get<Page<SpotifyTrack>>(url);
      out.push(...(page?.items ?? []));
      url = page?.next ?? null;
    }
    return out;
  }

  /** Full track list of one album (when a cached library dropped track lists to fit storage). */
  albumTracks(albumId: string): Promise<SpotifyTrack[]> {
    return this.remainingTracks(`/albums/${encodeURIComponent(albumId)}/tracks?limit=50`);
  }

  /** Newest saved album id, to tell cheaply whether a cached library is still current. */
  async newestSaved(): Promise<{ id: string | null; total: number }> {
    const page = await this.get<Page<SavedAlbumItem>>('/me/albums?limit=1');
    return { id: page?.items?.[0]?.album?.id ?? null, total: page?.total ?? 0 };
  }

  /** One artist's genres. The batch endpoint was removed for development-mode apps in 2026. */
  async artistGenres(id: string): Promise<string[]> {
    const a = await this.get<{ genres?: string[] }>(`/artists/${encodeURIComponent(id)}`);
    return (a?.genres ?? []).filter((g) => typeof g === 'string');
  }

  async me(): Promise<{ id: string; display_name?: string | null } | null> {
    return this.get('/me');
  }

  /** Start an album on a device (the Web Playback SDK's device in this tab). */
  async playAlbum(deviceId: string, albumUri: string): Promise<void> {
    await this.request('PUT', `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      context_uri: albumUri,
    });
  }
}
