/**
 * Generated artwork: the back of a sleeve (metadata + track list) and the vinyl label.
 * Serif display face (Fraunces) for titles, monospace (JetBrains Mono) for metadata, as on a real
 * reissue back. Canvas textures, created on demand for the one or two records that need them.
 */

import { CanvasTexture, SRGBColorSpace } from 'three';
import { luminance } from '../data/colour';
import { formatDuration } from '../data/format';
import { hashString, mulberry32 } from '../data/random';
import type { Album, Track } from '../data/types';
import { type Canvas, type Ctx, ctx2d, makeCanvas } from './textures';

const SERIF = '"Fraunces Variable", "Fraunces", Georgia, serif';
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
const SANS = '"Inter Variable", "Inter", system-ui, sans-serif';

function fitFont(
  ctx: Ctx,
  text: string,
  family: string,
  weight: number,
  start: number,
  maxWidth: number,
  min = 18,
): number {
  let size = start;
  ctx.font = `${weight} ${size}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && size > min) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

function wrap(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function paper(ctx: Ctx, size: number, seed: number): void {
  ctx.fillStyle = '#e6dcc8';
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(seed);
  // Fibres and faint foxing: the back of a sleeve that has been handled.
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(90, 70, 50, ${rand() * 0.05})`;
    ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1);
  }
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(90, 60, 30, 0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

/** Back of the sleeve. With no track list, the metadata block sits alone, centred, with generous margin. */
export function sleeveBackCanvas(album: Album, tracks: Track[] | null, size = 1024): Canvas {
  const canvas = makeCanvas(size, size);
  const ctx = ctx2d(canvas);
  paper(ctx, size, hashString(album.id));
  // Heavier and darker than print would need: the texture is minified 2-3x on screen.
  const ink = '#140d0a';
  const accent = album.palette.dominant;
  const m = size * 0.08;
  const inner = size - 2 * m;
  const meta = [
    album.year ? String(album.year) : null,
    album.label,
    album.type !== 'album' ? album.type.toUpperCase() : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  if (!tracks || tracks.length === 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = ink;
    const ts = fitFont(ctx, album.title, SERIF, 600, size * 0.075, inner * 0.85, 28);
    const titleLines = wrap(ctx, album.title, inner * 0.85).slice(0, 3);
    let y = size / 2 - (titleLines.length * ts * 1.1) / 2;
    ctx.font = `600 ${ts}px ${SERIF}`;
    for (const l of titleLines) {
      ctx.fillText(l, size / 2, y + ts * 0.8);
      y += ts * 1.1;
    }
    ctx.font = `400 ${size * 0.034}px ${SERIF}`;
    ctx.fillText(album.artist, size / 2, y + size * 0.05);
    ctx.fillStyle = accent;
    ctx.fillRect(size / 2 - size * 0.04, y + size * 0.08, size * 0.08, 3);
    ctx.fillStyle = ink;
    ctx.font = `400 ${size * 0.022}px ${MONO}`;
    ctx.fillText(meta, size / 2, y + size * 0.13);
    return canvas;
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = ink;
  const ts = fitFont(ctx, album.title, SERIF, 650, size * 0.068, inner, 28);
  ctx.fillText(album.title, m, m + ts * 0.85);
  ctx.font = `500 ${size * 0.038}px ${SERIF}`;
  ctx.fillText(album.artist, m, m + ts + size * 0.045);
  ctx.fillStyle = accent;
  ctx.fillRect(m, m + ts + size * 0.065, size * 0.12, 4);
  ctx.fillStyle = ink;
  ctx.font = `600 ${size * 0.026}px ${MONO}`;
  ctx.fillText(meta, m, m + ts + size * 0.115);

  // Two sides, like the vinyl: A and B.
  const top = m + ts + size * 0.18;
  const bottom = size - m - size * 0.06;
  const half = Math.ceil(tracks.length / 2);
  const sides = [tracks.slice(0, half), tracks.slice(half)];
  const colW = inner / 2 - size * 0.02;
  const rowH = Math.min(size * 0.05, (bottom - top - size * 0.05) / Math.max(1, half));
  sides.forEach((side, si) => {
    if (side.length === 0) return;
    const x = m + si * (inner / 2 + size * 0.02);
    ctx.font = `700 ${size * 0.028}px ${SANS}`;
    ctx.fillStyle = accent;
    ctx.fillText(si === 0 ? 'SIDE A' : 'SIDE B', x, top);
    ctx.fillStyle = ink;
    side.forEach((t, i) => {
      const y = top + size * 0.045 + i * rowH;
      ctx.font = `600 ${Math.min(size * 0.027, rowH * 0.62)}px ${MONO}`;
      const dur = t.durationMs ? formatDuration(t.durationMs) : '';
      const durW = ctx.measureText(dur).width;
      ctx.fillText(String(t.n), x, y);
      ctx.font = `500 ${Math.min(size * 0.032, rowH * 0.72)}px ${SERIF}`;
      let title = t.title;
      const maxW = colW - durW - size * 0.07;
      while (ctx.measureText(title).width > maxW && title.length > 3) title = `${title.slice(0, -2)}…`;
      ctx.fillText(title, x + size * 0.05, y);
      ctx.font = `600 ${Math.min(size * 0.027, rowH * 0.62)}px ${MONO}`;
      ctx.fillText(dur, x + colW - durW, y);
    });
  });
  if (album.durationMs) {
    ctx.font = `600 ${size * 0.022}px ${MONO}`;
    ctx.fillStyle = 'rgba(20, 13, 10, 0.75)';
    ctx.fillText(`TOTAL ${formatDuration(album.durationMs)}   ·   33⅓ RPM   ·   STEREO`, m, size - m);
  }
  return canvas;
}

/** Vinyl label: a flat disc in the cover's dominant colour, artist and title set small in a circle. */
export function labelCanvas(album: Album, size = 512): Canvas {
  const canvas = makeCanvas(size, size);
  const ctx = ctx2d(canvas);
  const c = size / 2;
  const colour = album.palette.dominant;
  const ink = luminance(colour) > 0.35 ? '#1d1512' : '#f3eadb';
  ctx.fillStyle = '#0c0b0c';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.995, 0, Math.PI * 2);
  ctx.fill();
  // Subtle printed ring.
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = ink;
  const ring = (text: string, radius: number, start: number, px: number, weight: number, family: string) => {
    ctx.font = `${weight} ${px}px ${family}`;
    const chars = [...text];
    const widths = chars.map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let angle = start - total / radius / 2;
    for (let i = 0; i < chars.length; i++) {
      const w = widths[i]!;
      angle += w / radius / 2;
      ctx.save();
      ctx.translate(c + Math.cos(angle) * radius, c + Math.sin(angle) * radius);
      ctx.rotate(angle + Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(chars[i]!, 0, 0);
      ctx.restore();
      angle += w / radius / 2;
    }
  };
  const artist = album.artist.toUpperCase();
  const title = album.title;
  ring(
    artist.length > 34 ? `${artist.slice(0, 33)}…` : artist,
    c * 0.74,
    -Math.PI / 2,
    size * 0.052,
    600,
    SANS,
  );
  ring(title.length > 40 ? `${title.slice(0, 39)}…` : title, c * 0.7, Math.PI / 2, size * 0.05, 500, SERIF);
  ctx.textAlign = 'center';
  ctx.font = `600 ${size * 0.05}px ${MONO}`;
  ctx.fillText('33⅓', c, c - size * 0.12);
  ctx.font = `400 ${size * 0.036}px ${MONO}`;
  ctx.fillText(album.year ? String(album.year) : 'STEREO', c, c + size * 0.15);
  return canvas;
}

export function canvasToTexture(canvas: Canvas, anisotropy = 4): CanvasTexture {
  const t = new CanvasTexture(canvas as HTMLCanvasElement);
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}
