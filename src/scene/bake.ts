/**
 * A tiny CPU light baker for the room's planar surfaces.
 *
 * The room is static and seen from a fixed camera, so its lighting is computed once into low-resolution
 * half-float lightmaps (soft by construction: bilinear upscaling blurs the shadows). One warm lamp with
 * a shade, a cool window, a warm ambient floor, analytic occluders for contact shadows and corner AO.
 * Records, crates and the turntable are lit in real time instead; see materials.ts.
 */

import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat, type Texture } from 'three';
import { hex, type RGB } from './textures';

export type V3 = [number, number, number];

export interface Box {
  min: V3;
  max: V3;
}

export interface BakeEnv {
  lamp: { position: V3; colour: RGB; intensity: number };
  window: { position: V3; normal: V3; colour: RGB; intensity: number; size: [number, number] };
  ambient: RGB;
  /** Boxes that cast lamp shadows and darken nearby surfaces. */
  occluders: Box[];
}

export interface Surface {
  origin: V3;
  u: V3;
  v: V3;
  normal: V3;
  /** Lightmap resolution in texels. */
  resU: number;
  resV: number;
  /** Extra per-surface darkening (0..1 multiplier) for corners, seams, contact. */
  ao?: (p: V3) => number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

function boxDistance(p: V3, b: Box): number {
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]);
  const dy = Math.max(b.min[1] - p[1], 0, p[1] - b.max[1]);
  const dz = Math.max(b.min[2] - p[2], 0, p[2] - b.max[2]);
  return Math.hypot(dx, dy, dz);
}

/** Slab test: does the segment p->q pass through the box? */
function segmentHitsBox(p: V3, q: V3, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = q[i]! - p[i]!;
    if (Math.abs(d) < 1e-9) {
      if (p[i]! < b.min[i]! || p[i]! > b.max[i]!) return false;
      continue;
    }
    let ta = (b.min[i]! - p[i]!) / d;
    let tb = (b.max[i]! - p[i]!) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return t1 > 1e-3 && t0 < 1 - 1e-3;
}

/**
 * The lampshade: strong pool downwards, a softer spill upwards, and fabric-filtered light sideways.
 * `dy` is the vertical component of the unit vector from the lamp to the point.
 */
function shade(dy: number): number {
  return dy < 0 ? 0.42 + 0.58 * Math.pow(-dy, 0.55) : 0.42 + 0.3 * Math.pow(dy, 0.8);
}

export function irradiance(p: V3, n: V3, env: BakeEnv, surfaceAo = 1): RGB {
  let r = env.ambient[0];
  let g = env.ambient[1];
  let b = env.ambient[2];

  // Lamp (point + shade), with hard shadows from occluders, softened later by bilinear upscaling.
  const toLamp = sub(env.lamp.position, p);
  const d = len(toLamp);
  const l: V3 = [toLamp[0] / d, toLamp[1] / d, toLamp[2] / d];
  const ndl = dot(n, l);
  if (ndl > 0) {
    const shadowed = env.occluders.some((box) => segmentHitsBox(p, env.lamp.position, box));
    if (!shadowed) {
      const e = (env.lamp.intensity * ndl * shade(-l[1])) / (d * d + 0.08);
      r += env.lamp.colour[0] * e;
      g += env.lamp.colour[1] * e;
      b += env.lamp.colour[2] * e;
    }
  }

  // Window: a dim cool area light approximated by its centre, with a cosine lobe out of the glass.
  const toWin = sub(env.window.position, p);
  const dw = len(toWin);
  const lw: V3 = [toWin[0] / dw, toWin[1] / dw, toWin[2] / dw];
  const ndw = dot(n, lw);
  const out = -dot(env.window.normal, lw);
  if (ndw > 0 && out > 0) {
    const e = (env.window.intensity * ndw * out) / (dw * dw + 0.5);
    r += env.window.colour[0] * e;
    g += env.window.colour[1] * e;
    b += env.window.colour[2] * e;
  }

  // Soft proximity occlusion from big objects (contact shadows under and behind furniture).
  let ao = surfaceAo;
  for (const box of env.occluders) {
    const dist = boxDistance(p, box);
    ao *= 1 - 0.55 * Math.exp(-dist / 0.12);
  }
  return [r * ao, g * ao, b * ao];
}

/** Bakes one surface to a half-float lightmap texture (linear, sampled with channel 0 = the mesh uv). */
export function bakeLightmap(surface: Surface, env: BakeEnv): Texture {
  const { resU, resV } = surface;
  const data = new Uint16Array(resU * resV * 4);
  for (let y = 0; y < resV; y++) {
    for (let x = 0; x < resU; x++) {
      const u = (x + 0.5) / resU;
      const v = (y + 0.5) / resV;
      const p: V3 = [
        surface.origin[0] + surface.u[0] * u + surface.v[0] * v,
        surface.origin[1] + surface.u[1] * u + surface.v[1] * v,
        surface.origin[2] + surface.u[2] * u + surface.v[2] * v,
      ];
      const ao = surface.ao ? surface.ao(p) : 1;
      const e = irradiance(p, surface.normal, env, ao);
      const i = (y * resU + x) * 4;
      data[i] = DataUtils.toHalfFloat(e[0]);
      data[i + 1] = DataUtils.toHalfFloat(e[1]);
      data[i + 2] = DataUtils.toHalfFloat(e[2]);
      data[i + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const tex = new DataTexture(data, resU, resV, RGBAFormat, HalfFloatType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.channel = 0;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

export const ROOM_LIGHT = {
  lampColour: hex('#ffb266'),
  windowColour: hex('#6f86a8'),
};
