/**
 * The fan: where each record in a crate stands, as a smooth function of s = i - f (never of the integer
 * index), so fast scrolling ripples through the crate instead of stepping.
 *
 * Pure maths, no three.js, so it is unit-tested directly. Output is in crate-local space: z runs from the
 * front wall (toward the camera) to the back, y is height above the riser, lean is degrees of lean-back
 * (negative leans toward the camera).
 */

import type { Tuning } from './tuning';

type FanParams = Tuning['fan'];

const smooth01 = (x: number) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};

/** 1 at the focus, 0 from one record away. */
export function focusWeight(s: number): number {
  return 1 - smooth01(Math.abs(s));
}

/** 0 at the focus, 1 from one record in front of it onwards. */
export function passedWeight(s: number): number {
  return s >= 0 ? 0 : smooth01(-s);
}

/** Gaussian-ish decay with half-maximum at `halfWidth` records. */
export function aheadWeight(s: number, halfWidth: number): number {
  if (s <= 0) return 1;
  return Math.pow(2, -((s / halfWidth) ** 2));
}

export interface RecordPose {
  /** Height offset (lift, sink and rake). */
  y: number;
  /** Degrees of lean-back. */
  lean: number;
}

export function recordPose(
  s: number,
  p: FanParams,
  strength = 1,
  out: RecordPose = { y: 0, lean: 0 },
): RecordPose {
  const fw = focusWeight(s) * strength;
  const pw = passedWeight(s) * strength;
  const aheadLean =
    p.restLean + (p.aheadLean - p.restLean) * aheadWeight(Math.max(s, 0), p.aheadHalfWidth) * strength;
  const rake =
    s > 0 ? p.rakePerRecord * p.rakeRecords * Math.tanh(s / p.rakeRecords) * smooth01(s) * strength : 0;
  out.y = p.focusLift * fw - p.sinkDepth * pw + rake;
  const restLike = Math.max(0, 1 - fw - pw);
  out.lean = fw * p.focusLean + pw * p.passedLean + restLike * (s >= 0 ? aheadLean : p.restLean);
  return out;
}

/** Spacing between two consecutive records whose midpoint sits at `sMid`. */
export function spacingAt(sMid: number, p: FanParams, strength = 1): number {
  // Fully passed pairs compress; the opening behind the focus fades out over the half record in front of it.
  const pw = passedWeight(sMid + 0.5) * strength;
  const open = sMid >= 0 ? aheadWeight(sMid, p.aheadHalfWidth) : 1 - smooth01(-sMid * 2);
  const base = p.restSpacing + p.aheadExtra * open * strength;
  const gap = p.focusGap * Math.exp(-(((Math.abs(sMid) - 0.5) / 0.6) ** 2)) * strength;
  const passed = p.restSpacing + (p.passedSpacing - p.restSpacing) * strength;
  return pw * passed + (1 - pw) * base + gap;
}

/** Lays out a whole crate. `z[i]` is the distance behind the front anchor (positive = further from camera). */
export function layoutCrate(
  count: number,
  f: number,
  p: FanParams,
  strength: number,
  out: { z: Float32Array; y: Float32Array; lean: Float32Array },
): void {
  const pose: RecordPose = { y: 0, lean: 0 };
  let z = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) z += spacingAt(i - 0.5 - f, p, strength);
    recordPose(i - f, p, strength, pose);
    out.z[i] = z;
    out.y[i] = pose.y;
    out.lean[i] = pose.lean;
  }
}

/** Depth of the stack at its longest (focus on the first record), for sizing bins. */
export function maxStackDepth(capacity: number, p: FanParams): number {
  let z = 0;
  for (let i = 1; i < capacity; i++) z += spacingAt(i - 0.5, p, 1);
  return z;
}
