/**
 * Real playback through the Spotify Web Playback SDK: this tab becomes a Spotify Connect device and albums
 * play here. The adapter reports album-level progress (tracks before the current one + position in it), so
 * the tonearm crosses the whole side exactly as with the simulated clock.
 *
 * The SDK needs Spotify Premium and a browser with EME (Widevine). When either is missing, or the SDK
 * cannot load, the adapter falls back to the simulated clock and says why (`onNote`), so the ritual still
 * runs and the UI can offer "Open in Spotify" instead.
 */

import type { Track } from '../data/types';
import type { SpotifyApi } from '../spotify/api';
import { IDLE_STATE, type PlaybackAdapter, type PlaybackState } from './adapter';
import { SimulatedAdapter } from './simulated';

export const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

/** The subset of the SDK's player state we use. */
export interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  context?: { uri?: string | null } | null;
  track_window?: {
    current_track?: { uri?: string; duration_ms?: number; linked_from?: { uri?: string | null } } | null;
    next_tracks?: unknown[];
  } | null;
}

export interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: never) => void): boolean;
  pause(): Promise<void>;
  resume(): Promise<void>;
  activateElement?(): Promise<void>;
}

export interface SdkOptions {
  name: string;
  volume: number;
  getOAuthToken: (cb: (token: string) => void) => void;
}

export type PlayerFactory = (opts: SdkOptions) => Promise<SdkPlayer>;

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (opts: SdkOptions) => SdkPlayer };
  }
}

let sdkPromise: Promise<void> | null = null;

/** Loads the SDK script once. */
export function loadSdk(timeoutMs = 15_000): Promise<void> {
  if (window.Spotify?.Player) return Promise.resolve();
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The Spotify player did not load in time.')), timeoutMs);
    window.onSpotifyWebPlaybackSDKReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('The Spotify player could not be loaded.'));
    };
    document.head.appendChild(script);
  }).catch((err) => {
    sdkPromise = null;
    throw err;
  });
  return sdkPromise;
}

export const browserPlayerFactory: PlayerFactory = async (opts) => {
  await loadSdk();
  return new window.Spotify!.Player(opts);
};

export interface SpotifyAdapterDeps {
  api: Pick<SpotifyApi, 'playAlbum'>;
  token: () => Promise<string>;
  /** Track list of an album (for album-level progress); null when unknown. */
  tracksOf: (albumUri: string) => Promise<Track[] | null>;
  /** Album length from the library, used by the fallback clock and before tracks are known. */
  durationOf: (albumUri: string) => number | null;
  createPlayer?: PlayerFactory;
  /** Called with a human-readable reason when real playback is unavailable (null once it works). */
  onNote?: (note: string | null) => void;
  now?: () => number;
  readyTimeoutMs?: number;
}

type Mode = 'starting' | 'sdk' | 'fallback';

/** Album-level position from an SDK state, or null when the current track is not on this album. */
export function albumPosition(
  tracks: readonly Track[],
  state: SdkState,
): { positionMs: number; index: number } | null {
  const cur = state.track_window?.current_track;
  const uris = [cur?.uri, cur?.linked_from?.uri].filter(Boolean);
  const index = tracks.findIndex((t) => t.uri && uris.includes(t.uri));
  if (index < 0) return null;
  const before = tracks.slice(0, index).reduce((s, t) => s + t.durationMs, 0);
  return { positionMs: before + state.position, index };
}

export class SpotifyAdapter implements PlaybackAdapter {
  readonly name = 'spotify';
  mode: Mode = 'starting';
  private fallback: SimulatedAdapter;
  private player: SdkPlayer | null = null;
  private deviceId: string | null = null;
  private ready: Promise<string | null>;
  private state: PlaybackState = { ...IDLE_STATE };
  private tracks: Track[] = [];
  /** Position at `anchorAt`; while playing the live position is interpolated from it. */
  private anchorAt = 0;
  private lastIndex = -1;
  private confirmed = false;
  private listeners = new Set<(s: PlaybackState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activated = false;
  private now: () => number;

  constructor(private deps: SpotifyAdapterDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.fallback = new SimulatedAdapter(deps.durationOf, this.now);
    this.fallback.subscribe((s) => {
      if (this.mode === 'fallback') this.emit(s);
    });
    this.ready = this.start();
  }

  /** Resolves with the device id, or null when playback fell back to the simulated clock. */
  whenReady(): Promise<string | null> {
    return this.ready;
  }

  private async start(): Promise<string | null> {
    const createPlayer = this.deps.createPlayer ?? browserPlayerFactory;
    try {
      const player = await createPlayer({
        name: 'Crate Digger',
        volume: 0.8,
        getOAuthToken: (cb) => {
          this.deps.token().then(cb, (err) => console.warn('spotify: no token for the player', err));
        },
      });
      this.player = player;
      const id = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The Spotify player did not become ready.')),
          this.deps.readyTimeoutMs ?? 20_000,
        );
        const fail = (msg: string) => (e: { message?: string }) => {
          clearTimeout(timer);
          reject(new Error(e?.message ? `${msg} (${e.message})` : msg));
        };
        player.addListener('ready', ({ device_id }: { device_id: string }) => {
          clearTimeout(timer);
          this.deviceId = device_id;
          resolve(device_id);
        });
        player.addListener('not_ready', () => {
          this.deviceId = null;
        });
        player.addListener('account_error', fail('Playing in the browser needs Spotify Premium.'));
        player.addListener('initialization_error', fail('This browser cannot play Spotify audio.'));
        player.addListener('authentication_error', fail('Spotify did not accept the login for playback.'));
        player.addListener('playback_error', (e: { message?: string }) =>
          console.warn('spotify playback:', e?.message),
        );
        player.addListener('player_state_changed', (s: SdkState | null) => this.onSdkState(s));
        void player.connect().then((ok) => {
          if (!ok) fail('Could not connect the Spotify player.')({});
        });
      });
      this.mode = 'sdk';
      this.deps.onNote?.(null);
      return id;
    } catch (err) {
      this.useFallback((err as Error).message);
      return null;
    }
  }

  private useFallback(reason: string): void {
    if (this.mode === 'fallback') return;
    console.warn('spotify: playing without audio:', reason);
    this.mode = 'fallback';
    this.deps.onNote?.(reason);
    try {
      this.player?.disconnect();
    } catch {
      /* ignore */
    }
    this.player = null;
  }

  /** Call from a user gesture: lets the SDK start audio without a later gesture (autoplay policy). */
  activate(): void {
    if (this.activated || !this.player?.activateElement) return;
    this.activated = true;
    void this.player.activateElement().catch(() => (this.activated = false));
  }

  async play(albumUri: string): Promise<void> {
    const deviceId = this.mode === 'starting' ? await this.ready : this.deviceId;
    if (this.mode === 'fallback' || !deviceId) {
      this.stopTimer();
      this.state = { ...IDLE_STATE };
      return this.fallback.play(albumUri);
    }
    this.tracks = (await this.deps.tracksOf(albumUri).catch(() => null)) ?? [];
    const total = this.tracks.reduce((s, t) => s + t.durationMs, 0) || this.deps.durationOf(albumUri) || 0;
    this.lastIndex = -1;
    this.confirmed = false;
    this.setState({ status: 'playing', albumUri, positionMs: 0, durationMs: total });
    try {
      await this.deps.api.playAlbum(deviceId, albumUri);
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.useFallback(
        status === 403
          ? 'Playing in the browser needs Spotify Premium.'
          : `Spotify could not start the album: ${(err as Error).message}`,
      );
      this.state = { ...IDLE_STATE };
      return this.fallback.play(albumUri);
    }
  }

  async pause(): Promise<void> {
    if (this.mode === 'fallback') return this.fallback.pause();
    if (this.state.status !== 'playing') return;
    this.setState({ ...this.state, status: 'paused', positionMs: this.livePosition() });
    await this.player?.pause().catch(() => {});
  }

  async resume(): Promise<void> {
    if (this.mode === 'fallback') return this.fallback.resume();
    if (this.state.status !== 'paused') return;
    this.setState({ ...this.state, status: 'playing' });
    await this.player?.resume().catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.mode === 'fallback') return this.fallback.stop();
    const was = this.state.status;
    this.setState({ ...IDLE_STATE });
    if (was === 'playing') await this.player?.pause().catch(() => {});
  }

  getState(): PlaybackState {
    if (this.mode === 'fallback') return this.fallback.getState();
    if (this.state.status !== 'playing') return this.state;
    return { ...this.state, positionMs: this.livePosition() };
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopTimer();
    this.fallback.dispose();
    this.listeners.clear();
    try {
      this.player?.disconnect();
    } catch {
      /* ignore */
    }
  }

  // --- SDK events --------------------------------------------------------------------------------------

  /** Exposed for tests; the SDK calls it on every change (play, pause, seek, track change). */
  onSdkState(s: SdkState | null): void {
    if (
      this.mode !== 'sdk' ||
      !this.state.albumUri ||
      this.state.status === 'idle' ||
      this.state.status === 'ended'
    )
      return;
    if (!s) {
      // Playback moved to another device: the record keeps its place, the arm lifts.
      if (this.state.status === 'playing')
        this.setState({ ...this.state, status: 'paused', positionMs: this.livePosition() });
      return;
    }
    const contextUri = s.context?.uri;
    const at = albumPosition(this.tracks, s);
    if (!this.confirmed) {
      // Until Spotify reports our album, events still describe whatever played before.
      if (contextUri ? contextUri !== this.state.albumUri : !at) return;
      this.confirmed = true;
    } else if (contextUri && contextUri !== this.state.albumUri) {
      // Something else was started from another app: treat it as the end of this record.
      this.setState({ ...this.state, status: 'ended', positionMs: this.state.durationMs });
      return;
    }
    // The SDK reports the end of a context as a pause at position 0, often back on the first track.
    const onLast = this.tracks.length > 0 && this.lastIndex === this.tracks.length - 1;
    const unknownTracks = this.tracks.length === 0 && (s.track_window?.next_tracks?.length ?? 1) === 0;
    if (
      s.paused &&
      (onLast || unknownTracks) &&
      (s.position === 0 || (at !== null && at.index !== this.lastIndex) || s.duration - s.position < 1500)
    ) {
      this.setState({ ...this.state, status: 'ended', positionMs: this.state.durationMs });
      return;
    }
    if (at) this.lastIndex = at.index;
    const positionMs = at ? at.positionMs : this.state.positionMs;
    // Without a track list (or for a relinked track) fall back to the SDK's own track length.
    const durationMs = this.state.durationMs || s.duration || 0;
    this.setState({ ...this.state, status: s.paused ? 'paused' : 'playing', positionMs, durationMs });
  }

  // --- internals ---------------------------------------------------------------------------------------

  private livePosition(): number {
    const elapsed = this.state.status === 'playing' ? this.now() - this.anchorAt : 0;
    return Math.min(this.state.durationMs || Infinity, this.state.positionMs + elapsed);
  }

  private setState(next: PlaybackState): void {
    this.state = next;
    this.anchorAt = this.now();
    if (next.status === 'playing') this.startTimer();
    else this.stopTimer();
    this.emit(this.getState());
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit(this.getState()), 1000);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emit(s: PlaybackState): void {
    this.listeners.forEach((l) => l(s));
  }
}
