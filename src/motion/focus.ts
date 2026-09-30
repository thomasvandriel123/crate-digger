import { SPRINGS, Spring } from './spring';

export interface FocusTuning {
  /** Velocity decay per second while coasting (inertia). */
  friction: number;
  /** Below this speed (records/s) the focus stops coasting and springs onto the nearest record. */
  settleSpeed: number;
  /** Hard cap on coasting speed (records/s). */
  maxSpeed: number;
  stiffness: number;
  damping: number;
}

export const DEFAULT_FOCUS_TUNING: FocusTuning = {
  friction: 4.2,
  settleSpeed: 0.2,
  maxSpeed: 60,
  stiffness: SPRINGS.focus.stiffness,
  damping: SPRINGS.focus.damping,
};

type Mode = 'rest' | 'coast' | 'spring' | 'drag';

/**
 * The focus float `f` for one crate. Every record transform is a smooth function of `i - f`, so coasting
 * through the crate ripples instead of stepping. Input adds velocity (wheel, fling) or drags directly;
 * once slow enough, a spring (stiffness 180, damping 22) seats `f` on a whole record.
 */
export class FocusController {
  readonly spring: Spring;
  private mode: Mode = 'rest';
  private max = 0;
  private dragVelocity = 0;
  tuning: FocusTuning;

  constructor(count: number, initial = 0, tuning: FocusTuning = DEFAULT_FOCUS_TUNING) {
    this.tuning = tuning;
    this.spring = new Spring(initial, tuning);
    this.setCount(count);
  }

  get value(): number {
    return this.spring.value;
  }

  get velocity(): number {
    return this.spring.velocity;
  }

  /** The record the focus is heading to (the settled index). */
  get target(): number {
    if (this.mode === 'spring' || this.mode === 'rest') return this.spring.target;
    return this.clamp(Math.round(this.spring.value));
  }

  get index(): number {
    return this.clamp(Math.round(this.spring.value));
  }

  get moving(): boolean {
    return this.mode !== 'rest';
  }

  get dragging(): boolean {
    return this.mode === 'drag';
  }

  setCount(count: number): void {
    this.max = Math.max(0, count - 1);
    if (this.spring.target > this.max) this.goTo(this.max);
  }

  private clamp(i: number): number {
    return Math.min(this.max, Math.max(0, i));
  }

  /** Wheel/trackpad: add velocity in records per second. */
  impulse(recordsPerSecond: number): void {
    if (this.mode === 'drag') return;
    const v = (this.mode === 'coast' ? this.spring.velocity : this.spring.velocity * 0.5) + recordsPerSecond;
    this.spring.velocity = Math.max(-this.tuning.maxSpeed, Math.min(this.tuning.maxSpeed, v));
    this.mode = 'coast';
  }

  /** Animate to a record (keyboard, click, search result). */
  goTo(index: number, instant = false): void {
    const i = this.clamp(Math.round(index));
    if (instant) {
      this.spring.snap(i);
      this.mode = 'rest';
      return;
    }
    this.spring.setParams(this.tuning);
    this.spring.target = i;
    this.mode = 'spring';
  }

  /** Relative keyboard step from where the focus is heading, so repeated presses accumulate. */
  step(delta: number, instant = false): void {
    this.goTo(this.target + delta, instant);
  }

  dragStart(): void {
    this.mode = 'drag';
    this.dragVelocity = 0;
    this.spring.velocity = 0;
  }

  /** Direct manipulation: move by `records` over `dt` seconds (for fling velocity estimation). */
  dragBy(records: number, dt: number): void {
    if (this.mode !== 'drag') return;
    let next = this.spring.value + records;
    // Rubber band past the ends: resistance grows the further you pull.
    if (next < 0) next = -Math.sqrt(-next) * 0.6;
    if (next > this.max) next = this.max + Math.sqrt(next - this.max) * 0.6;
    this.spring.value = next;
    if (dt > 0) {
      const v = records / dt;
      this.dragVelocity = this.dragVelocity * 0.7 + v * 0.3;
    }
  }

  dragEnd(): void {
    if (this.mode !== 'drag') return;
    this.mode = 'coast';
    this.spring.velocity = Math.max(-this.tuning.maxSpeed, Math.min(this.tuning.maxSpeed, this.dragVelocity));
  }

  /** Advance one fixed substep. Returns true while moving. */
  update(dt: number): boolean {
    const s = this.spring;
    switch (this.mode) {
      case 'rest':
      case 'drag':
        return this.mode === 'drag';
      case 'coast': {
        s.velocity *= Math.exp(-this.tuning.friction * dt);
        s.value += s.velocity * dt;
        const outside = s.value < 0 || s.value > this.max;
        if (outside || Math.abs(s.velocity) < this.tuning.settleSpeed) {
          s.setParams(this.tuning);
          s.target = this.clamp(Math.round(s.value));
          this.mode = 'spring';
        }
        return true;
      }
      case 'spring':
        s.step(dt);
        if (s.settle(5e-4)) this.mode = 'rest';
        return true;
    }
  }
}
