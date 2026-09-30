/**
 * The one interface the UI and scene use for playback. The adapter is the only module that knows whether
 * sound comes from Spotify; the turntable animation reads the same state either way.
 */

export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlaybackState {
  status: PlaybackStatus;
  albumUri: string | null;
  positionMs: number;
  durationMs: number;
}

export interface PlaybackAdapter {
  readonly name: string;
  play(albumUri: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  /** Current state with a live (interpolated) position. Cheap: safe to call every frame. */
  getState(): PlaybackState;
  /** State stream: status changes plus periodic position updates. Returns an unsubscribe function. */
  subscribe(listener: (state: PlaybackState) => void): () => void;
  dispose(): void;
}

export const IDLE_STATE: PlaybackState = Object.freeze({
  status: 'idle',
  albumUri: null,
  positionMs: 0,
  durationMs: 0,
});
