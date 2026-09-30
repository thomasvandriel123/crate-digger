import { clamp01, type Easing, easeInOut } from './easing';

/**
 * Time-based tween for choreographed moves (fixed duration + curve). Interruptible: `retarget` starts a new
 * tween from the current value, so nothing restarts from scratch or snaps.
 */
export class Tween {
  from = 0;
  to = 0;
  value = 0;
  duration = 0;
  elapsed = 0;
  easing: Easing = easeInOut;
  delay = 0;
  private done = true;
  private onDone: (() => void) | null = null;

  constructor(value = 0) {
    this.value = value;
    this.from = value;
    this.to = value;
  }

  get active(): boolean {
    return !this.done;
  }

  /** Progress in [0, 1] of the current tween (1 when idle). */
  get progress(): number {
    return this.done ? 1 : clamp01((this.elapsed - this.delay) / Math.max(this.duration, 1e-6));
  }

  start(
    to: number,
    durationMs: number,
    easing: Easing = easeInOut,
    opts: { from?: number; delayMs?: number; onDone?: () => void } = {},
  ): this {
    this.from = opts.from ?? this.value;
    this.value = this.from;
    this.to = to;
    this.duration = Math.max(0, durationMs) / 1000;
    this.delay = Math.max(0, opts.delayMs ?? 0) / 1000;
    this.elapsed = 0;
    this.easing = easing;
    this.done = false;
    this.onDone = opts.onDone ?? null;
    if (this.duration === 0 && this.delay === 0) this.finish();
    return this;
  }

  snap(value: number): this {
    this.value = this.from = this.to = value;
    this.done = true;
    this.onDone = null;
    return this;
  }

  update(dt: number): boolean {
    if (this.done) return false;
    this.elapsed += dt;
    const t = this.elapsed - this.delay;
    if (t < 0) return true;
    if (t >= this.duration) {
      this.finish();
      return true;
    }
    this.value = this.from + (this.to - this.from) * this.easing(t / this.duration);
    return true;
  }

  private finish(): void {
    this.value = this.to;
    this.done = true;
    const cb = this.onDone;
    this.onDone = null;
    cb?.();
  }
}

/** Awaitable delay driven by the frame clock (so it pauses with the loop, unlike setTimeout). */
export class Clock {
  now = 0;
  private waits: { at: number; resolve: () => void }[] = [];

  advance(dt: number): void {
    this.now += dt;
    if (this.waits.length === 0) return;
    const due = this.waits.filter((w) => w.at <= this.now);
    this.waits = this.waits.filter((w) => w.at > this.now);
    due.forEach((w) => w.resolve());
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.waits.push({ at: this.now + ms / 1000, resolve }));
  }

  get pending(): boolean {
    return this.waits.length > 0;
  }
}
