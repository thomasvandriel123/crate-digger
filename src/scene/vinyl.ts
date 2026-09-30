/**
 * A 12-inch vinyl disc: 30.5 cm, 2 mm, with a procedural label in the cover's dominant colour and
 * silent gaps between tracks placed from the album's real track durations.
 */

import type { CanvasTexture } from 'three';
import { CylinderGeometry, Mesh, type Scene } from 'three';
import type { Album } from '../data/types';
import { MAX_GAPS, VinylMaterial } from './materials';
import { canvasToTexture, labelCanvas } from './sleeveArt';

export const DISC_RADIUS = 0.1525;
const LEAD_IN = 0.1495;
const RUN_OUT = 0.062;

const discGeometry = new CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.002, 128, 1);

/** Radii of the gaps between tracks (a side per half of the album, like the sleeve back). */
export function trackGapRadii(album: Album): number[] {
  const tracks = album.tracks;
  if (!tracks || tracks.length < 2) return [];
  const half = Math.ceil(tracks.length / 2);
  const side = tracks.slice(0, half);
  const total = side.reduce((s, t) => s + Math.max(1, t.durationMs), 0);
  const gaps: number[] = [];
  let acc = 0;
  for (let i = 0; i < side.length - 1; i++) {
    acc += Math.max(1, side[i]!.durationMs);
    // Groove pitch is roughly constant, so radius falls linearly with elapsed time.
    gaps.push(LEAD_IN - (LEAD_IN - RUN_OUT) * (acc / total));
  }
  return gaps.slice(0, MAX_GAPS);
}

export class VinylDisc {
  readonly mesh: Mesh;
  readonly material: VinylMaterial;
  album: Album | null = null;
  private label: CanvasTexture | null = null;

  constructor(scene: Scene) {
    this.material = new VinylMaterial();
    this.mesh = new Mesh(discGeometry, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setAlbum(album: Album | null): void {
    if (this.album?.id === album?.id) return;
    this.album = album;
    this.label?.dispose();
    this.label = null;
    const u = this.material.uniforms;
    if (!album) {
      u.uHasLabel.value = 0;
      return;
    }
    this.label = canvasToTexture(labelCanvas(album));
    u.uLabel.value = this.label;
    u.uHasLabel.value = 1;
    u.uLabelColor.value.set(album.palette.dominant);
    const gaps = trackGapRadii(album);
    (u.uGaps.value as Float32Array).fill(0).set(gaps);
    u.uGapCount.value = gaps.length;
  }

  dispose(): void {
    this.label?.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
