/** Cubic-bezier easing (CSS semantics) and the named curves from the motion spec. */

export type Easing = (t: number) => number;

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number) => {
    // Newton-Raphson, falling back to bisection where the slope flattens.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveT(x));
  };
}

export const linear: Easing = (t) => t;
export const easeIn: Easing = cubicBezier(0.42, 0, 1, 1);
export const easeOut: Easing = cubicBezier(0, 0, 0.58, 1);
export const easeInOut: Easing = cubicBezier(0.42, 0, 0.58, 1);

/** Named curves from the timing reference. */
export const EASE = {
  crateSwitch: cubicBezier(0.65, 0, 0.35, 1),
  pull: cubicBezier(0.22, 1, 0.36, 1),
  flip: cubicBezier(0.45, 0, 0.15, 1),
  inOut: easeInOut,
  in: easeIn,
  out: easeOut,
  outQuart: cubicBezier(0.25, 1, 0.5, 1),
} as const;

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
