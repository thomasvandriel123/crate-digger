import { describe, expect, it } from 'vitest';
import { RESHELVE, planReshelve, staggerDelays } from '../../src/motion/choreography';
import { EASE, cubicBezier } from '../../src/motion/easing';
import { FocusController } from '../../src/motion/focus';
import { FixedStepper, SUBSTEP, Spring } from '../../src/motion/spring';
import { Tween } from '../../src/motion/tween';

function simulate(hz: number, seconds: number) {
  const spring = new Spring(0, { stiffness: 180, damping: 22 });
  spring.target = 1;
  const stepper = new FixedStepper();
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i++) stepper.advance(1 / hz, (dt) => spring.step(dt));
  return spring.value;
}

describe('Spring + FixedStepper', () => {
  it('is frame-rate independent (60, 120, 144 Hz land on the same value)', () => {
    const at60 = simulate(60, 0.25);
    expect(simulate(120, 0.25)).toBeCloseTo(at60, 2);
    expect(simulate(144, 0.25)).toBeCloseTo(at60, 2);
  });

  it('focus spring settles in about 350 ms without visible overshoot', () => {
    const spring = new Spring(0, { stiffness: 180, damping: 22 });
    spring.target = 1;
    let t = 0;
    let peak = 0;
    while (t < 0.35) {
      spring.step(SUBSTEP);
      peak = Math.max(peak, spring.value);
      t += SUBSTEP;
    }
    expect(spring.value).toBeGreaterThan(0.9);
    for (let i = 0; i < 480; i++) {
      spring.step(SUBSTEP);
      peak = Math.max(peak, spring.value);
    }
    expect(peak).toBeLessThan(1.03);
    expect(spring.settle(1e-3)).toBe(true);
  });

  it('clamps huge frame deltas (tab switch) to 50 ms', () => {
    const stepper = new FixedStepper();
    expect(stepper.advance(5, () => {})).toBe(12);
  });
});

describe('easing', () => {
  it('matches CSS endpoints and symmetry', () => {
    const ease = cubicBezier(0.42, 0, 0.58, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 4);
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1, 4);
  });

  it('pull curve front-loads motion (ease-out)', () => {
    expect(EASE.pull(0.3)).toBeGreaterThan(0.6);
  });
});

describe('Tween', () => {
  it('runs for its duration, honours delay, and retargets from its current value', () => {
    const t = new Tween(0);
    let done = 0;
    t.start(10, 100, (x) => x, { delayMs: 50, onDone: () => done++ });
    t.update(0.05);
    expect(t.value).toBe(0);
    t.update(0.05);
    expect(t.value).toBeCloseTo(5);
    t.start(0, 100, (x) => x);
    expect(t.from).toBeCloseTo(5);
    expect(done).toBe(0);
    t.update(1);
    expect(t.value).toBe(0);
    expect(t.active).toBe(false);
  });
});

describe('FocusController', () => {
  const run = (fc: FocusController, seconds: number) => {
    for (let t = 0; t < seconds; t += SUBSTEP) fc.update(SUBSTEP);
  };

  it('coasts with inertia then seats on a whole record', () => {
    const fc = new FocusController(48);
    fc.impulse(12);
    run(fc, 4);
    expect(fc.moving).toBe(false);
    expect(Number.isInteger(fc.value)).toBe(true);
    expect(fc.value).toBeGreaterThan(1);
  });

  it('keyboard steps accumulate from the target, clamped to the crate', () => {
    const fc = new FocusController(10);
    fc.step(1);
    fc.step(5);
    expect(fc.target).toBe(6);
    fc.step(10);
    expect(fc.target).toBe(9);
    run(fc, 1.5);
    expect(fc.value).toBe(9);
    fc.goTo(-3);
    expect(fc.target).toBe(0);
  });

  it('springs back inside the crate after coasting past an end', () => {
    const fc = new FocusController(5, 4);
    fc.impulse(40);
    run(fc, 3);
    expect(fc.value).toBe(4);
  });

  it('drag moves directly and flings on release', () => {
    const fc = new FocusController(48, 10);
    fc.dragStart();
    for (let i = 0; i < 10; i++) fc.dragBy(0.3, 1 / 60);
    expect(fc.value).toBeCloseTo(13);
    fc.dragEnd();
    run(fc, 4);
    expect(fc.value).toBeGreaterThan(14);
    expect(Number.isInteger(fc.value)).toBe(true);
  });

  it('instant goTo snaps (reduced motion)', () => {
    const fc = new FocusController(48);
    fc.goTo(20, true);
    expect(fc.value).toBe(20);
    expect(fc.moving).toBe(false);
  });
});

describe('choreography', () => {
  it('stagger compresses to fit the window', () => {
    expect(staggerDelays(3, 8, 240, 160)).toEqual([0, 8, 16]);
    const many = staggerDelays(100, 8, 240, 160);
    expect(many[99]! + 160).toBeLessThanOrEqual(240);
    expect(staggerDelays(0, 8, 240, 160)).toEqual([]);
  });

  it('keeps every phase inside the 900 ms budget', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `r${i}`);
    const plan = planReshelve(ids, ids);
    const lastOut = Math.max(...plan.outgoing.values()) + RESHELVE.outDurationMs;
    const lastIn = Math.max(...plan.incoming.values()) + RESHELVE.inDurationMs;
    expect(lastOut).toBeLessThanOrEqual(RESHELVE.outEndMs);
    expect(Math.min(...plan.incoming.values())).toBe(RESHELVE.inStartMs);
    expect(lastIn).toBeLessThanOrEqual(RESHELVE.totalMs);
  });
});
