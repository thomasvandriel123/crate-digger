import { describe, expect, it } from 'vitest';
import { layoutCrate, maxStackDepth, recordPose, spacingAt } from '../../src/scene/fan';
import { tuning } from '../../src/scene/tuning';

const p = tuning.fan;

function layout(count: number, f: number) {
  const out = { z: new Float32Array(count), y: new Float32Array(count), lean: new Float32Array(count) };
  layoutCrate(count, f, p, 1, out);
  return out;
}

describe('fan', () => {
  it('lifts the focus, sinks the passed, rakes the ahead', () => {
    expect(recordPose(0, p).y).toBeCloseTo(p.focusLift);
    expect(recordPose(0, p).lean).toBeCloseTo(p.focusLean);
    expect(recordPose(-3, p).y).toBeCloseTo(-p.sinkDepth);
    expect(recordPose(-3, p).lean).toBeCloseTo(p.passedLean);
    expect(recordPose(2, p).y).toBeGreaterThan(0);
    expect(recordPose(2, p).lean).toBeGreaterThan(p.restLean);
    expect(recordPose(30, p).lean).toBeCloseTo(p.restLean, 1);
  });

  it('is continuous in f: a tiny focus change never jumps a record', () => {
    for (let f = 0; f < 10; f += 0.01) {
      const a = layout(20, f);
      const b = layout(20, f + 0.001);
      for (let i = 0; i < 20; i++) {
        expect(Math.abs(a.z[i]! - b.z[i]!)).toBeLessThan(0.002);
        expect(Math.abs(a.y[i]! - b.y[i]!)).toBeLessThan(0.002);
        expect(Math.abs(a.lean[i]! - b.lean[i]!)).toBeLessThan(0.2);
      }
    }
  });

  it('keeps records ordered front to back with positive spacing', () => {
    for (const f of [0, 3.5, 12, 47]) {
      const { z } = layout(48, f);
      for (let i = 1; i < 48; i++) expect(z[i]!).toBeGreaterThan(z[i - 1]!);
    }
    expect(spacingAt(-5, p)).toBeCloseTo(p.passedSpacing, 3);
    expect(spacingAt(20, p)).toBeCloseTo(p.restSpacing, 3);
  });

  it('opens more space right behind the focus than far away', () => {
    expect(spacingAt(1.5, p)).toBeGreaterThan(spacingAt(8, p));
  });

  it('neighbour strength calms the fan', () => {
    expect(recordPose(0, p, p.neighbourFan).y).toBeLessThan(recordPose(0, p).y);
  });

  it('bins deep enough for a full crate stay a plausible size', () => {
    const depth = maxStackDepth(48, p);
    expect(depth).toBeGreaterThan(0.5);
    expect(depth).toBeLessThan(0.8);
  });
});
