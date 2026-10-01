/**
 * Cover palettes in the browser, for libraries read live from Spotify. The same method as the Python
 * ingest (ingest/palette.py): cluster the pixels in OKLab with a small deterministic k-means and pick the
 * dominant colour by chroma-weighted cluster size; flag near-greyscale covers as mono. Sampled at 32 px
 * from Spotify's smallest (64 px) image, which is plenty for three swatches.
 */

import type { Palette } from '../data/types';

const K = 6;
const ITERATIONS = 14;
const MONO_CHROMA = 0.028;
const CHROMA_BIAS = 0.03;
const MIN_SWATCH_DISTANCE = 0.08;
export const SAMPLE = 32;

type Lab = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
};

export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((c) =>
      Math.round(toGamma(c) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const dist2 = (p: Lab, q: Lab) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/** Small deterministic PRNG so the same cover always yields the same palette. */
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kmeans(points: Lab[], k: number): { centroids: Lab[]; labels: Int32Array } {
  const rand = mulberry(7);
  const n = points.length;
  const centroids: Lab[] = [points[Math.floor(rand() * n)]!];
  const d2 = new Float64Array(n);
  while (centroids.length < Math.min(k, n)) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const c of centroids) best = Math.min(best, dist2(points[i]!, c));
      d2[i] = best;
      total += best;
    }
    if (total <= 1e-12) break;
    let r = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= d2[i]!;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push([...points[pick]!]);
  }
  const labels = new Int32Array(n);
  for (let it = 0; it < ITERATIONS; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, j) => {
        const d = dist2(points[i]!, c);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      labels[i] = best;
    }
    let moved = false;
    centroids.forEach((c, j) => {
      const sum: Lab = [0, 0, 0];
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (labels[i] !== j) continue;
        const p = points[i]!;
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
        count++;
      }
      if (count === 0) return;
      const next: Lab = [sum[0] / count, sum[1] / count, sum[2] / count];
      if (dist2(next, c) > 1e-12) moved = true;
      centroids[j] = next;
    });
    if (!moved) break;
  }
  return { centroids, labels };
}

/** Palette from RGBA pixels (e.g. ImageData.data). Transparent pixels are ignored. */
export function extractPalette(rgba: ArrayLike<number>): Palette | null {
  const points: Lab[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    points.push(srgbToOklab(rgba[i]! / 255, rgba[i + 1]! / 255, rgba[i + 2]! / 255));
  }
  if (points.length === 0) return null;
  const meanChroma = points.reduce((s, p) => s + Math.hypot(p[1], p[2]), 0) / points.length;
  const mono = meanChroma < MONO_CHROMA;

  const { centroids, labels } = kmeans(points, K);
  const sizes = centroids.map(() => 0);
  labels.forEach((l) => (sizes[l]! += 1 / labels.length));
  const score = centroids.map((c, j) =>
    mono ? sizes[j]! : sizes[j]! * (Math.hypot(c[1], c[2]) + CHROMA_BIAS),
  );
  const byScore = centroids.map((_, j) => j).sort((a, b) => score[b]! - score[a]!);

  const picked: Lab[] = [];
  for (const j of byScore) {
    if (sizes[j]! <= 0) continue;
    const c = centroids[j]!;
    if (picked.every((p) => Math.sqrt(dist2(p, c)) >= MIN_SWATCH_DISTANCE)) picked.push(c);
    if (picked.length === 3) break;
  }
  for (const j of centroids.map((_, j) => j).sort((a, b) => sizes[b]! - sizes[a]!)) {
    if (picked.length === 3) break;
    if (!picked.includes(centroids[j]!)) picked.push(centroids[j]!);
  }
  while (picked.length < 3) picked.push(picked[picked.length - 1]!);

  const d = picked[0]!;
  const chroma = Math.hypot(d[1], d[2]);
  const hue = ((Math.atan2(d[2], d[1]) * 180) / Math.PI + 360) % 360;
  return {
    dominant: oklabToHex(d),
    swatches: picked.map(oklabToHex),
    hue: Math.round(hue * 10) / 10,
    chroma: Math.round(chroma * 10000) / 10000,
    lightness: Math.round(d[0] * 10000) / 10000,
    mono,
  };
}

/** Fetches a cover image (CORS) and computes its palette; null when the image cannot be read. */
export async function paletteFromUrl(
  url: string,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<Palette | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob(), {
      resizeWidth: SAMPLE,
      resizeHeight: SAMPLE,
      resizeQuality: 'medium',
    });
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(SAMPLE, SAMPLE)
        : Object.assign(document.createElement('canvas'), { width: SAMPLE, height: SAMPLE });
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
    bitmap.close();
    return extractPalette(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    return null;
  }
}
