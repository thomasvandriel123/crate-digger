/**
 * Frame-time measurement and adaptive resolution.
 *
 * Only consecutive full-rate frames are measured (the idle 15 fps tick is intentional, not slow). If the
 * 95th percentile stays above 18 ms for a second, the pixel ratio steps down by 0.25 (floor 1.0); after
 * 5 s of stable frames it steps back up toward the device cap.
 */

export class FrameTimes {
  private buf: Float32Array;
  private i = 0;
  private n = 0;

  constructor(size = 240) {
    this.buf = new Float32Array(size);
  }

  push(ms: number): void {
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.buf.length;
    this.n = Math.min(this.n + 1, this.buf.length);
  }

  get count(): number {
    return this.n;
  }

  percentile(p: number, last = this.n): number {
    const k = Math.min(last, this.n);
    if (k === 0) return 0;
    const out = new Float32Array(k);
    for (let j = 0; j < k; j++) out[j] = this.buf[(this.i - 1 - j + this.buf.length) % this.buf.length]!;
    out.sort();
    return out[Math.min(k - 1, Math.floor(p * k))]!;
  }

  mean(last = this.n): number {
    const k = Math.min(last, this.n);
    if (k === 0) return 0;
    let s = 0;
    for (let j = 0; j < k; j++) s += this.buf[(this.i - 1 - j + this.buf.length) % this.buf.length]!;
    return s / k;
  }

  clear(): void {
    this.i = 0;
    this.n = 0;
  }
}

export class AdaptiveResolution {
  ratio: number;
  private window = new FrameTimes(600);
  private overSince: number | null = null;
  private stableSince: number | null = null;
  enabled = true;

  constructor(
    private max: number,
    private floor = 1.0,
    private onChange: (ratio: number) => void = () => {},
  ) {
    this.ratio = max;
  }

  /** Feed one measured frame (ms) at time `now` (ms). */
  sample(frameMs: number, now: number): void {
    if (!this.enabled) return;
    this.window.push(frameMs);
    if (this.window.count < 30) return;
    const p95 = this.window.percentile(0.95, 60);
    if (p95 > 18) {
      this.stableSince = null;
      this.overSince ??= now;
      if (now - this.overSince >= 1000 && this.ratio > this.floor) {
        this.set(Math.max(this.floor, this.ratio - 0.25));
        this.overSince = null;
      }
    } else {
      this.overSince = null;
      if (p95 <= 16.7) {
        this.stableSince ??= now;
        if (now - this.stableSince >= 5000 && this.ratio < this.max) {
          this.set(Math.min(this.max, this.ratio + 0.25));
          this.stableSince = null;
        }
      } else {
        this.stableSince = null;
      }
    }
  }

  /** Frames stopped being measured (idle); don't let stale samples decide. */
  pause(): void {
    this.overSince = null;
    this.stableSince = null;
  }

  private set(ratio: number): void {
    this.ratio = ratio;
    this.window.clear();
    this.onChange(ratio);
  }
}
