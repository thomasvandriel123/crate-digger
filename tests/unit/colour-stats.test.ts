import { describe, expect, it } from 'vitest';
import { colourBin, luminance, sweepKey } from '../../src/data/colour';
import { normaliseLibrary } from '../../src/data/library';
import { AdaptiveResolution, FrameTimes } from '../../src/scene/stats';

describe('colour bins', () => {
  const p = (hue: number, chroma = 0.12, mono = false) => ({ hue, chroma, lightness: 0.5, mono });

  it('files hues where a person would', () => {
    expect(colourBin(p(25))).toBe('red');
    expect(colourBin(p(355))).toBe('red');
    expect(colourBin(p(55))).toBe('orange');
    expect(colourBin(p(95))).toBe('yellow');
    expect(colourBin(p(150))).toBe('green');
    expect(colourBin(p(260))).toBe('blue');
    expect(colourBin(p(330))).toBe('pink');
  });

  it('greys and flagged covers are black and white', () => {
    expect(colourBin(p(200, 0.01))).toBe('mono');
    expect(colourBin(p(30, 0.2, true))).toBe('mono');
    expect(sweepKey(p(30, 0.01))[0]).toBeGreaterThan(360);
  });

  it('computes WCAG luminance', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1);
  });
});

describe('frame stats', () => {
  it('reports percentiles over a ring buffer', () => {
    const f = new FrameTimes(10);
    for (let i = 1; i <= 20; i++) f.push(i);
    expect(f.count).toBe(10);
    expect(f.percentile(0.95)).toBe(20);
    expect(f.mean()).toBeCloseTo(15.5);
  });

  it('adaptive resolution steps down after a slow second and back up after 5 s of stable frames', () => {
    const changes: number[] = [];
    const ar = new AdaptiveResolution(2, 1, (r) => changes.push(r));
    let t = 0;
    for (let i = 0; i < 150; i++) ar.sample(25, (t += 25));
    expect(changes[0]).toBe(1.75);
    const lowest = ar.ratio;
    expect(lowest).toBeGreaterThanOrEqual(1);
    // One 0.25 step back up per 5 s of stable frames.
    for (let i = 0; i < 700; i++) ar.sample(8, (t += 8));
    expect(ar.ratio).toBe(lowest + 0.25);
    for (let i = 0; i < 5000; i++) ar.sample(8, (t += 8));
    expect(ar.ratio).toBe(2);
  });
});

describe('viewer settings in library.json', () => {
  it('reads an optional crate capacity', () => {
    expect(
      normaliseLibrary({ version: 1, albums: [{ id: 'a' }], viewer: { crateCapacity: 40 } }).crateCapacity,
    ).toBe(40);
    expect(normaliseLibrary({ version: 1, albums: [{ id: 'a' }] }).crateCapacity).toBeNull();
  });
});
