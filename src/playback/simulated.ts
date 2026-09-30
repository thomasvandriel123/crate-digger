import { IDLE_STATE, type PlaybackAdapter, type PlaybackState } from './adapter';

/**
 * v1 default: no audio from Spotify, just an honest clock over the album's total duration from the
 * library, so the ritual (tonearm drifting inward, auto-return at the end) runs exactly as it would with
 * real playback. `durationOf` resolves an album URI to its length in ms.
 */
export class SimulatedAdapter implements PlaybackAdapter {
  readonly name = 'simulated';
  private state: PlaybackState = { ...IDLE_STATE };
  private startedAt = 0;
  private listeners = new Set<(s: PlaybackState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private durationOf: (albumUri: string) => number | null,
    private now: () => number = () => performance.now(),
    /** Position tick for subscribers; the scene reads getState() per frame for smooth motion. */
    private tickMs = 1000,
  ) {}

  async play(albumUri: string): Promise<void> {
    const duration = Math.max(1000, this.durationOf(albumUri) ?? 40 * 60 * 1000);
    this.state = { status: 'playing', albumUri, positionMs: 0, durationMs: duration };
    this.startedAt = this.now();
    this.startTimer();
    this.emit();
  }

  async pause(): Promise<void> {
    if (this.state.status !== 'playing') return;
    this.state = { ...this.state, status: 'paused', positionMs: this.position() };
    this.stopTimer();
    this.emit();
  }

  async resume(): Promise<void> {
    if (this.state.status !== 'paused') return;
    this.startedAt = this.now() - this.state.positionMs;
    this.state = { ...this.state, status: 'playing' };
    this.startTimer();
    this.emit();
  }

  async stop(): Promise<void> {
    this.stopTimer();
    this.state = { ...IDLE_STATE };
    this.emit();
  }

  getState(): PlaybackState {
    if (this.state.status !== 'playing') return this.state;
    const pos = this.position();
    if (pos >= this.state.durationMs) {
      this.finish();
      return this.state;
    }
    return { ...this.state, positionMs: pos };
  }

  subscribe(listener: (state: PlaybackState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopTimer();
    this.listeners.clear();
  }

  private position(): number {
    return Math.min(this.state.durationMs, this.now() - this.startedAt);
  }

  private finish(): void {
    this.stopTimer();
    this.state = { ...this.state, status: 'ended', positionMs: this.state.durationMs };
    this.emit();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      const s = this.getState();
      if (s.status === 'playing') this.emit();
    }, this.tickMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emit(): void {
    const s = this.getState();
    this.listeners.forEach((l) => l(s));
  }
}
