/**
 * Damped springs integrated at a fixed 1/240 s step, so motion is identical at 60, 120 and 144 Hz.
 * Semi-implicit Euler is stable at this step size for the stiffness range we use (<= 600).
 */

export const SUBSTEP = 1 / 240;
/** Frame delta clamp: survives tab switches and breakpoints without a huge catch-up jump. */
export const MAX_FRAME_DT = 0.05;

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass?: number;
}

export const SPRINGS = {
  focus: { stiffness: 180, damping: 22 },
  hover: { stiffness: 300, damping: 26 },
  shelve: { stiffness: 120, damping: 20 },
  crate: { stiffness: 140, damping: 24 },
} as const satisfies Record<string, SpringParams>;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  stiffness: number;
  damping: number;
  mass: number;

  constructor(value = 0, params: SpringParams = SPRINGS.focus) {
    this.value = value;
    this.target = value;
    this.stiffness = params.stiffness;
    this.damping = params.damping;
    this.mass = params.mass ?? 1;
  }

  setParams(params: SpringParams): this {
    this.stiffness = params.stiffness;
    this.damping = params.damping;
    this.mass = params.mass ?? 1;
    return this;
  }

  /** Jump without animation (reduced motion, first layout, off-screen records). */
  snap(value: number): this {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    return this;
  }

  step(dt: number): void {
    const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
    this.velocity += (force / this.mass) * dt;
    this.value += this.velocity * dt;
  }

  isAtRest(eps = 1e-4): boolean {
    return Math.abs(this.value - this.target) < eps && Math.abs(this.velocity) < eps * 10;
  }

  settle(eps = 1e-4): boolean {
    if (this.isAtRest(eps)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }
}

/** Fixed-step accumulator: feed it frame deltas, it calls `step(SUBSTEP)` the right number of times. */
export class FixedStepper {
  private acc = 0;

  /** Returns the number of substeps run this frame. */
  advance(frameDt: number, step: (dt: number) => void): number {
    this.acc += Math.min(Math.max(frameDt, 0), MAX_FRAME_DT);
    let n = 0;
    while (this.acc >= SUBSTEP) {
      step(SUBSTEP);
      this.acc -= SUBSTEP;
      n++;
    }
    return n;
  }

  reset(): void {
    this.acc = 0;
  }
}
