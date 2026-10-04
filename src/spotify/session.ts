/**
 * The Spotify connection for this page: login and callback, the live library, and the playback adapter.
 * UI components call `connectSpotify` / `disconnectSpotify`; main.ts drives the rest at boot.
 */

import { normaliseLibrary } from '../data/library';
import type { Album, Library, Track } from '../data/types';
import { SpotifyAdapter } from '../playback/spotify';
import { browserStorage as storage } from '../state/storage';
import { $deck, $held, $library, patchSpotify } from '../state/store';
import { SpotifyApi, SpotifyApiError } from './api';
import { configuredClientId, currentRedirectUri, SpotifyAuth, SpotifyAuthError } from './auth';
import { genreMap } from './genres';
import { type Progress, type RawLibrary, SpotifyLibraryLoader } from './library';
import { mapTracks } from './mapping';
import { paletteFromUrl } from './palette';

/** Shown to accounts the Spotify app has not allowlisted (Spotify caps development apps at five users). */
export const NOT_INVITED =
  'The live Spotify connection is invite-only for now: Spotify lets this app serve only five accounts. Upload your Spotify library export instead, it works for everyone.';

/** Thrown when the account has no saved albums: not an error, but nothing to shelve either. */
export class EmptySpotifyLibrary extends Error {}

let auth: SpotifyAuth | null = null;
let api: SpotifyApi | null = null;
let loader: SpotifyLibraryLoader | null = null;

/** Set up from the configured client id. Returns false when Spotify is not configured for this build. */
export function initSpotify(clientId = configuredClientId()): boolean {
  if (!clientId) {
    patchSpotify({ status: 'unconfigured' });
    return false;
  }
  auth = new SpotifyAuth({
    clientId,
    redirectUri: currentRedirectUri(),
    storage: storage('local'),
    session: storage('session'),
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
    crypto: window.crypto,
    navigate: (url) => location.assign(url),
  });
  api = new SpotifyApi(auth);
  loader = new SpotifyLibraryLoader({
    api,
    storage: storage('local'),
    genres: genreMap(),
    palette: (url) => paletteFromUrl(url),
    now: () => Date.now(),
  });
  patchSpotify({ status: auth.isConnected ? 'loading' : 'disconnected' });
  return true;
}

export function spotifyConnected(): boolean {
  return auth?.isConnected ?? false;
}

/**
 * Finish a login if this page load is Spotify's redirect back. Restores the view the user left from and
 * removes the one-time code from the address bar either way.
 */
export async function handleSpotifyCallback(): Promise<void> {
  if (!auth) return;
  const params = new URLSearchParams(location.search);
  if (!params.has('state') || !(params.has('code') || params.has('error'))) return;
  patchSpotify({ status: 'connecting', message: null });
  try {
    const result = await auth.completeLogin(location.search);
    // A new login may be a different account: never show the previous one's shelves.
    loader?.clear();
    history.replaceState(history.state, '', `${location.pathname}${result?.returnTo ?? ''}`);
    patchSpotify({ status: 'loading' });
  } catch (err) {
    history.replaceState(history.state, '', location.pathname);
    patchSpotify({ status: 'disconnected', message: (err as Error).message });
  }
}

/** Start the login: off to Spotify, back to this view afterwards. */
export function connectSpotify(): void {
  if (!auth) return;
  if (location.hostname === 'localhost') {
    // Spotify accepts plain-http redirects only to loopback IP literals, never to "localhost".
    const here = new URL(location.href);
    here.hostname = '127.0.0.1';
    patchSpotify({
      status: 'disconnected',
      message: `Spotify does not accept "localhost" as a login address. Open ${here.origin}${here.pathname} and connect from there.`,
    });
    return;
  }
  patchSpotify({ status: 'connecting', message: null });
  auth
    .beginLogin(location.search)
    .catch((err: Error) => patchSpotify({ status: 'error', message: err.message }));
}

/** Forget the login and every cached piece of the library, then reload without it. */
export function disconnectSpotify(): void {
  auth?.logout();
  loader?.clear();
  location.assign(location.pathname);
}

function progressText(p: Progress): string {
  if (p.phase === 'albums') return `Reading your saved albums… ${p.done} of ${p.total}`;
  return `Looking at the covers… ${p.done} of ${p.total}`;
}

/** Apply a rebuilt library when nothing is in hand or on the deck, so a record never vanishes mid-play. */
function applyWhenIdle(raw: RawLibrary): void {
  const idle = () => $deck.get().phase === 'empty' && $held.get() === null;
  const apply = () => $library.set(normaliseLibrary(raw));
  if (idle()) {
    apply();
    return;
  }
  const check = () => {
    if (!idle()) return;
    stopDeck();
    stopHeld();
    apply();
  };
  const stopDeck = $deck.listen(check);
  const stopHeld = $held.listen(check);
}

function onBackgroundError(err: unknown): void {
  console.warn('spotify: background refresh failed', err);
  if (err instanceof SpotifyAuthError) patchSpotify({ status: 'error', message: err.message });
}

/** Background work after the room is up: newer saves, artist genres, the account name. */
async function refreshInBackground(
  current: RawLibrary,
  cachedHead: Parameters<SpotifyLibraryLoader['isStale']>[0] | null,
) {
  if (!api || !loader) return;
  void api
    .me()
    .then((me) => patchSpotify({ user: me?.display_name || me?.id || null }))
    .catch(() => {});
  let library = current;
  try {
    if (cachedHead && (await loader.isStale(cachedHead))) {
      library = await loader.build(undefined, current);
      if (library.albums.length > 0) applyWhenIdle(library);
    }
    const enriched = await loader.enrichGenres(library);
    if (enriched) applyWhenIdle(enriched);
  } catch (err) {
    onBackgroundError(err);
  }
}

/**
 * The connected account's saved albums as a library: the cached copy at once when there is one (refreshed
 * in the background), otherwise built now with progress reported to `$spotify.progress`.
 */
export async function loadSpotifyLibrary(): Promise<Library> {
  if (!loader) throw new Error('Spotify is not configured.');
  patchSpotify({ status: 'loading', progress: 'Connecting to Spotify…' });
  try {
    const cached = loader.cached();
    let raw: RawLibrary;
    if (cached && cached.library.albums.length > 0) {
      raw = loader.withGenres(cached.library);
    } else {
      raw = await loader.build((p) => patchSpotify({ progress: progressText(p) }));
    }
    if (raw.albums.length === 0) {
      throw new EmptySpotifyLibrary('Your Spotify library has no saved albums yet.');
    }
    void refreshInBackground(raw, cached);
    patchSpotify({ status: 'connected', progress: null, message: null });
    return normaliseLibrary(raw);
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 403) {
      // Development-mode Spotify apps only serve the (at most five) accounts added in the dashboard.
      auth?.logout();
      loader.clear();
      patchSpotify({ status: 'disconnected', progress: null, message: NOT_INVITED });
      throw new SpotifyAuthError(NOT_INVITED);
    } else if (err instanceof SpotifyAuthError) {
      auth?.logout();
      loader.clear();
      patchSpotify({ status: 'disconnected', progress: null, message: err.message });
    } else if (err instanceof EmptySpotifyLibrary) {
      patchSpotify({ status: 'connected', progress: null });
    } else {
      patchSpotify({ status: 'error', progress: null, message: (err as Error).message });
    }
    throw err;
  }
}

/** Track list for a Spotify album whose cached copy dropped it to fit browser storage. */
export async function spotifyTracks(album: Album): Promise<Track[] | null> {
  if (!api) return null;
  try {
    return mapTracks(await api.albumTracks(album.id));
  } catch {
    return null;
  }
}

/** Real playback in this tab, falling back to the simulated clock (with a note) when it cannot work. */
export function createSpotifyAdapter(
  tracksOf: (albumUri: string) => Promise<Track[] | null>,
  durationOf: (albumUri: string) => number | null,
): SpotifyAdapter | null {
  if (!auth || !api || !auth.isConnected) return null;
  const a = auth;
  return new SpotifyAdapter({
    api,
    token: () => a.accessToken(),
    tracksOf,
    durationOf,
    onNote: (note) => patchSpotify({ playbackNote: note }),
  });
}
