/**
 * Procedural canvas textures for the room. Everything is generated at startup from seeded noise, so the
 * repo ships no image assets and no third-party textures (see CREDITS.md). Surfaces are small (<= 512 px)
 * because the camera is fixed and they are seen at a known size.
 */

import { mulberry32 } from '../data/random';

export type Canvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(width: number, height: number): Canvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}

export function ctx2d(canvas: Canvas): Ctx {
  const ctx = canvas.getContext('2d', { willReadFrequently: false }) as Ctx | null;
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

// --- noise ----------------------------------------------------------------------------------------------

export class ValueNoise {
  private perm: Uint8Array;
  private values: Float32Array;

  constructor(seed = 1) {
    const rand = mulberry32(seed);
    this.values = new Float32Array(256).map(() => rand());
    this.perm = new Uint8Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  private v(x: number, y: number): number {
    return this.values[this.perm[(this.perm[x & 255]! + y) & 511]!]!;
  }

  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const w = yf * yf * (3 - 2 * yf);
    const a = this.v(xi, yi);
    const b = this.v(xi + 1, yi);
    const c = this.v(xi, yi + 1);
    const d = this.v(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  }

  fbm(x: number, y: number, octaves = 4): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }
}

export type RGB = [number, number, number];

export function hex(value: string): RGB {
  const n = parseInt(value.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Fill a canvas per pixel. `fn` returns linear-ish 0..1 RGB (written as sRGB bytes as-is). */
export function paint(
  width: number,
  height: number,
  fn: (u: number, v: number, x: number, y: number) => RGB,
): Canvas {
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas);
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn((x + 0.5) / width, (y + 0.5) / height, x, y);
      const i = (y * width + x) * 4;
      d[i] = Math.max(0, Math.min(255, r * 255));
      d[i + 1] = Math.max(0, Math.min(255, g * 255));
      d[i + 2] = Math.max(0, Math.min(255, b * 255));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- albedo generators (u, v in 0..1 over the surface; `scale` = metres per texture) -------------------

/** Walnut-ish wood grain running along u. */
export function woodAlbedo(
  seed: number,
  light = '#8a5a36',
  dark = '#5e3a22',
  ringScale = 1,
): (u: number, v: number) => RGB {
  const n = new ValueNoise(seed);
  const a = hex(light);
  const b = hex(dark);
  return (u, v) => {
    const warp = n.fbm(u * 2.2, v * 9, 4) * 3.2;
    const grain = Math.sin((v * 38 * ringScale + warp) * Math.PI);
    const streak = n.fbm(u * 40, v * 2.4, 3);
    let t = 0.5 + 0.28 * grain + 0.4 * (streak - 0.5);
    t = Math.max(0, Math.min(1, t));
    const fine = (n.noise(u * 600, v * 18) - 0.5) * 0.06;
    const c = mixRGB(a, b, t);
    return [c[0] + fine, c[1] + fine * 0.8, c[2] + fine * 0.6];
  };
}

/** Floorboards: planks along u with seams and per-plank tone. */
export function floorAlbedo(seed: number, planks = 14): (u: number, v: number) => RGB {
  const n = new ValueNoise(seed);
  const rand = mulberry32(seed);
  const tones = Array.from({ length: planks * 4 }, () => 0.8 + rand() * 0.4);
  const offsets = Array.from({ length: planks }, () => rand());
  const base = hex('#3b2a21');
  const dark = hex('#20160f');
  return (u, v) => {
    const row = Math.floor(v * planks);
    const inRow = v * planks - row;
    const along = u * 3 + offsets[row]!;
    const seg = Math.floor(along);
    const tone = tones[(row * 4 + (seg & 3)) % tones.length]!;
    const grain = n.fbm(along * 6, (row + inRow) * 5, 4);
    const t = 0.35 + 0.5 * grain;
    const c = mixRGB(base, dark, t);
    const seam = inRow < 0.035 || inRow > 0.965 || Math.abs(along - seg) < 0.004 ? 0.55 : 1;
    return [c[0] * tone * seam, c[1] * tone * seam, c[2] * tone * seam];
  };
}

/** Lime-plaster wall: mottled, slightly desaturated warm brown. */
export function plasterAlbedo(seed: number, colour = '#3a2a22'): (u: number, v: number) => RGB {
  const n = new ValueNoise(seed);
  const c = hex(colour);
  return (u, v) => {
    const m = n.fbm(u * 7, v * 5, 5);
    const f = 0.86 + 0.28 * m;
    return [c[0] * f, c[1] * f, c[2] * f];
  };
}

/** A kilim-style rug: border bands and stepped diamonds in the one saturated warm accent. */
export function rugAlbedo(seed: number): (u: number, v: number) => RGB {
  const n = new ValueNoise(seed);
  const red = hex('#7a3b2e');
  const deep = hex('#4a221b');
  const ochre = hex('#b0773a');
  const cream = hex('#c9b595');
  const ink = hex('#2a1a16');
  return (u, v) => {
    const wear = 0.85 + 0.3 * n.fbm(u * 6, v * 6, 4);
    const fibre = 0.94 + 0.12 * n.noise(u * 900, v * 700);
    const bu = Math.min(u, 1 - u);
    const bv = Math.min(v, 1 - v);
    const b = Math.min(bu * 1.5, bv);
    let c: RGB;
    if (b < 0.02) c = ink;
    else if (b < 0.05) c = cream;
    else if (b < 0.1) c = Math.floor(u * 40 + v * 40) % 2 === 0 ? deep : ochre;
    else if (b < 0.115) c = cream;
    else {
      const cu = (u - 0.5) * 3;
      const cv = (v - 0.5) * 2;
      const du = Math.abs(cu - Math.round(cu));
      const dv = Math.abs(cv * 1.3 - Math.round(cv * 1.3));
      const d = Math.floor((du + dv) * 8);
      c = d === 0 ? cream : d === 2 ? ochre : d === 4 ? deep : red;
    }
    const f = wear * fibre;
    return [c[0] * f, c[1] * f, c[2] * f];
  };
}

// --- special textures --------------------------------------------------------------------------------

/** Night city through the window: deep blue gradient, soft bokeh lights, a hint of skyline. */
export function nightWindowTexture(seed: number, width = 256, height = 384): Canvas {
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas);
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, '#0b1020');
  g.addColorStop(0.55, '#16223a');
  g.addColorStop(1, '#2a2a3a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  const rand = mulberry32(seed);
  // Blurred skyline blocks.
  ctx.filter = 'blur(6px)';
  for (let i = 0; i < 9; i++) {
    const w = 20 + rand() * 50;
    const h = 60 + rand() * 160;
    ctx.fillStyle = `rgba(8, 10, 18, ${0.6 + rand() * 0.3})`;
    ctx.fillRect(rand() * width - 10, height - h * 0.9 - 40, w, h + 60);
  }
  ctx.filter = 'none';
  // Bokeh: warm windows and street lights, cool signage.
  const colours = ['255, 196, 120', '255, 170, 90', '255, 220, 170', '140, 170, 255', '255, 120, 110'];
  for (let i = 0; i < 70; i++) {
    const x = rand() * width;
    const y = height * (0.35 + rand() * 0.6);
    const r = 3 + rand() * 13;
    const col = colours[Math.floor(rand() * colours.length)]!;
    const a = 0.12 + rand() * 0.45;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${col}, ${a})`);
    grad.addColorStop(0.7, `rgba(${col}, ${a * 0.8})`);
    grad.addColorStop(1, `rgba(${col}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/** An abstract print for a frame: cut-paper shapes on warm paper (two seeds give two different prints). */
export function printTexture(seed: number, width = 256, height = 320): Canvas {
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas);
  const rand = mulberry32(seed);
  ctx.fillStyle = '#d8ccb4';
  ctx.fillRect(0, 0, width, height);
  const palettes = [
    ['#b5452c', '#1f3b57', '#d9a441', '#2d2a26'],
    ['#2f5d50', '#c86b3c', '#e3c77d', '#3b2f4a'],
  ];
  const pal = palettes[seed % palettes.length]!;
  const m = 26;
  ctx.fillStyle = '#efe6d2';
  ctx.fillRect(m, m, width - 2 * m, height - 2 * m);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = pal[i % pal.length]!;
    ctx.beginPath();
    const cx = m + rand() * (width - 2 * m);
    const cy = m + rand() * (height - 2 * m - 40);
    const r = 20 + rand() * 60;
    if (i % 3 === 0) ctx.arc(cx, cy, r, 0, Math.PI * 2);
    else if (i % 3 === 1) ctx.rect(cx - r, cy - r * 0.4, r * 1.6, r * 0.8);
    else {
      ctx.moveTo(cx, cy - r);
      ctx.quadraticCurveTo(cx + r * 1.4, cy, cx, cy + r);
      ctx.quadraticCurveTo(cx - r * 0.3, cy, cx, cy - r);
    }
    ctx.fill();
  }
  ctx.fillStyle = '#3a2f28';
  ctx.font = '600 13px serif';
  ctx.fillText(seed % 2 ? 'KISSATEN · 1978' : 'LATE SET · NO. 4', m + 4, height - m - 10);
  return canvas;
}

/** Speaker grille cloth: fine weave. */
export function grilleTexture(seed: number, size = 128): Canvas {
  const n = new ValueNoise(seed);
  const base = hex('#1d1715');
  return paint(size, size, (u, v, x, y) => {
    const weave = (x + y) % 2 === 0 ? 1.1 : 0.85;
    const m = 0.9 + 0.2 * n.fbm(u * 8, v * 8, 3);
    return [base[0] * weave * m, base[1] * weave * m, base[2] * weave * m];
  });
}

/** Soft radial blob for fake contact shadows (alpha in the red channel is not needed: we use luminance). */
export function blobTexture(size = 128, falloff = 1.6): Canvas {
  const canvas = makeCanvas(size, size);
  const ctx = ctx2d(canvas);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(20, 14, 11, 0.9)');
  g.addColorStop(0.45 / falloff, 'rgba(20, 14, 11, 0.55)');
  g.addColorStop(1, 'rgba(20, 14, 11, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Soft round sprite for dust motes. */
export function moteTexture(size = 64): Canvas {
  const canvas = makeCanvas(size, size);
  const ctx = ctx2d(canvas);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255, 236, 210, 1)');
  g.addColorStop(0.35, 'rgba(255, 220, 180, 0.45)');
  g.addColorStop(1, 'rgba(255, 210, 160, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Leaf with a midrib, for the plant (alpha-tested). */
export function leafTexture(size = 128): Canvas {
  const canvas = makeCanvas(size, size);
  const ctx = ctx2d(canvas);
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#3d5a2c');
  g.addColorStop(1, '#22361b');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(size / 2, 2);
  ctx.bezierCurveTo(size * 0.98, size * 0.3, size * 0.8, size * 0.85, size / 2, size - 2);
  ctx.bezierCurveTo(size * 0.2, size * 0.85, size * 0.02, size * 0.3, size / 2, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(160, 190, 110, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size / 2, 6);
  ctx.lineTo(size / 2, size - 6);
  ctx.stroke();
  return canvas;
}
