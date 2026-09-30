/**
 * The row of record bins. The active bin sits front and centre; neighbours stand left and right, turned
 * inward and dimmed. Switching crate slides the row (700 ms, the crate-switch curve) while the room stays
 * put, so the turntable never leaves the frame however many crates the library fills.
 */

import type { Matrix4 } from 'three';
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  Euler,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Crate } from '../data/types';
import { EASE } from '../motion/easing';
import { Tween } from '../motion/tween';
import { maxStackDepth } from './fan';
import { LitMaterial } from './materials';
import { blobTexture, ctx2d, makeCanvas, paint, woodAlbedo } from './textures';
import { tuning } from './tuning';

const DEG = Math.PI / 180;
const WALL = 0.018;

export interface BinDims {
  width: number;
  depth: number;
  /** Local z of the front anchor where record 0 stands. */
  frontZ: number;
}

export function binDims(capacity: number): BinDims {
  const c = tuning.crate;
  const depth = maxStackDepth(capacity, tuning.fan) + c.frontMargin + 0.06;
  return { width: c.innerWidth, depth, frontZ: depth / 2 - c.frontMargin };
}

function binGeometry(d: BinDims): BufferGeometry {
  const c = tuning.crate;
  const W = d.width;
  const D = d.depth;
  const H = c.wallHeight;
  const Hf = c.frontWallHeight;
  const parts: BufferGeometry[] = [];
  const box = (w: number, h: number, dd: number, x: number, y: number, z: number) => {
    const g = new BoxGeometry(w, h, dd);
    g.translate(x, y, z);
    parts.push(g);
  };
  box(W + 2 * WALL, 0.02, D + 2 * WALL, 0, -0.01, 0);
  box(WALL, H, D + 2 * WALL, -(W / 2 + WALL / 2), H / 2, 0);
  box(WALL, H, D + 2 * WALL, W / 2 + WALL / 2, H / 2, 0);
  box(W, H, WALL, 0, H / 2, -(D / 2 + WALL / 2));
  box(W, Hf, WALL, 0, Hf / 2, D / 2 + WALL / 2);
  // Legs and a low stretcher, so the bin reads as furniture standing on the rug.
  const legH = c.floorY;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1])
      box(0.032, legH, 0.032, sx * (W / 2 + WALL / 2 - 0.004), -legH / 2 - 0.02, sz * (D / 2 - 0.02));
    box(0.02, 0.03, D - 0.04, sx * (W / 2 + WALL / 2 - 0.004), -legH * 0.72, 0);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

function labelCanvas(text: string) {
  const canvas = makeCanvas(256, 96);
  const ctx = ctx2d(canvas);
  ctx.fillStyle = '#e9dfca';
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = 'rgba(80, 60, 40, 0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 244, 84);
  ctx.fillStyle = '#2b1f1a';
  let size = 54;
  ctx.font = `600 ${size}px "Caveat", "Fraunces Variable", cursive`;
  while (ctx.measureText(text).width > 224 && size > 22) {
    size -= 2;
    ctx.font = `600 ${size}px "Caveat", "Fraunces Variable", cursive`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 52);
  return canvas;
}

class Bin {
  readonly group = new Group();
  readonly material: LitMaterial;
  readonly labelTexture: CanvasTexture;
  readonly presence = new Tween(1);
  label = '';
  /** Direction the bin slides when entering/exiting (-1 left, 1 right). */
  side = 1;

  constructor(geometry: BufferGeometry, shadowMat: MeshBasicMaterial, woodMap: CanvasTexture, d: BinDims) {
    this.material = new LitMaterial({ map: woodMap, color: '#ffffff', roughness: 0.75, specular: 0.12 });
    const mesh = new Mesh(geometry, this.material);
    this.group.add(mesh);
    this.labelTexture = new CanvasTexture(labelCanvas('') as HTMLCanvasElement);
    this.labelTexture.colorSpace = SRGBColorSpace;
    const tag = new Mesh(
      new PlaneGeometry(0.12, 0.045),
      new LitMaterial({ map: this.labelTexture, roughness: 0.9, specular: 0.02 }),
    );
    tag.position.set(0, tuning.crate.frontWallHeight * 0.55, d.depth / 2 + WALL + 0.0015);
    this.group.add(tag);
    const shadow = new Mesh(new PlaneGeometry(d.width + 0.3, d.depth + 0.3), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -tuning.crate.floorY + 0.006;
    this.group.add(shadow);
    this.group.matrixAutoUpdate = false;
  }

  setLabel(text: string, force = false): void {
    if (text === this.label && !force) return;
    this.label = text;
    this.labelTexture.image = labelCanvas(text) as HTMLCanvasElement;
    this.labelTexture.needsUpdate = true;
  }

  dispose(): void {
    this.material.dispose();
    this.labelTexture.dispose();
    this.group.traverse((o) => {
      if (o instanceof Mesh && o.material !== this.material && !(o.material instanceof MeshBasicMaterial))
        o.material.dispose();
    });
  }
}

export class CrateRow {
  readonly group = new Group();
  readonly active = new Tween(0);
  activeIndex = 0;
  dims: BinDims;
  private crates: Crate[] = [];
  private bins = new Map<number, Bin>();
  private ghosts: Bin[] = [];
  private pool: Bin[] = [];
  private geometry: BufferGeometry;
  private woodMap: CanvasTexture;
  private shadowMat: MeshBasicMaterial;
  private tmpQ = new Quaternion();
  private tmpE = new Euler(0, 0, 0, 'YXZ');
  private tmpV = new Vector3();
  private one = new Vector3(1, 1, 1);
  reducedMotion = false;

  constructor(capacity: number) {
    this.group.name = 'crates';
    this.dims = binDims(capacity);
    this.geometry = binGeometry(this.dims);
    this.woodMap = new CanvasTexture(
      paint(256, 256, woodAlbedo(17, '#8a5a36', '#5e3a22', 0.9)) as HTMLCanvasElement,
    );
    this.woodMap.colorSpace = SRGBColorSpace;
    this.woodMap.anisotropy = 4;
    const shadowTex = new CanvasTexture(blobTexture(128, 1.2) as HTMLCanvasElement);
    shadowTex.colorSpace = SRGBColorSpace;
    this.shadowMat = new MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    });
  }

  get count(): number {
    return this.crates.length;
  }

  crate(k: number): Crate | undefined {
    return this.crates[k];
  }

  /** Current (animated) active position. */
  get a(): number {
    return this.active.value;
  }

  get moving(): boolean {
    return this.active.active || [...this.bins.values(), ...this.ghosts].some((b) => b.presence.active);
  }

  /**
   * Apply a new layout. Bins keep their place relative to the active crate, so the one in front of you
   * stays in front of you; bins with no crate behind them slide out and fade, new ones slide in.
   */
  setLayout(crates: Crate[], activeIndex: number, animate: boolean): void {
    const shift = activeIndex - this.activeIndex;
    const remapped = new Map<number, Bin>();
    for (const [k, bin] of this.bins) remapped.set(k + shift, bin);
    this.bins = remapped;
    this.crates = crates;
    this.activeIndex = activeIndex;
    this.active.snap(activeIndex);

    for (const [k, bin] of [...this.bins]) {
      const crate = crates[k];
      if (!crate || Math.abs(k - activeIndex) > 2.5) {
        this.bins.delete(k);
        if (animate && Math.abs(k - activeIndex) <= 1.5) {
          bin.side = k === activeIndex ? 1 : Math.sign(k - activeIndex);
          bin.presence.start(0, 380, EASE.inOut, { onDone: () => this.retire(bin) });
          this.ghosts.push(bin);
          (bin as Bin & { ghostK: number }).ghostK = k;
        } else {
          this.release(bin);
        }
      } else {
        bin.setLabel(crate.label);
      }
    }
    this.ensureBins(animate);
  }

  private retire(bin: Bin): void {
    this.ghosts = this.ghosts.filter((g) => g !== bin);
    this.release(bin);
  }

  private release(bin: Bin): void {
    this.group.remove(bin.group);
    this.pool.push(bin);
  }

  private acquire(): Bin {
    const bin = this.pool.pop() ?? new Bin(this.geometry, this.shadowMat, this.woodMap, this.dims);
    this.group.add(bin.group);
    return bin;
  }

  /** Create bins for crates that entered the visible window. */
  private ensureBins(animate: boolean): void {
    const a = this.active.value;
    for (let k = Math.floor(a - 2.5); k <= Math.ceil(a + 2.5); k++) {
      const crate = this.crates[k];
      if (!crate) continue;
      if (Math.abs(k - a) > 2.5) continue;
      if (!this.bins.has(k)) {
        const bin = this.acquire();
        bin.setLabel(crate.label);
        bin.side = Math.sign(k - a) || 1;
        if (animate && Math.abs(k - a) <= 1.5)
          bin.presence.start(1, 420, EASE.inOut, { from: 0, delayMs: 150 });
        else bin.presence.snap(1);
        this.bins.set(k, bin);
      }
    }
    for (const [k, bin] of [...this.bins]) {
      if (Math.abs(k - a) > 2.6) {
        this.bins.delete(k);
        this.release(bin);
      }
    }
  }

  /** Slide the row to crate k (user switch). */
  switchTo(k: number): boolean {
    const target = Math.max(0, Math.min(this.crates.length - 1, k));
    if (target === this.activeIndex) return false;
    this.activeIndex = target;
    if (this.reducedMotion) this.active.snap(target);
    else this.active.start(target, 700, EASE.crateSwitch);
    return true;
  }

  update(dt: number): boolean {
    let moving = this.active.update(dt);
    for (const bin of [...this.bins.values(), ...this.ghosts]) moving = bin.presence.update(dt) || moving;
    this.ensureBins(false);
    const a = this.active.value;
    for (const [k, bin] of this.bins) this.place(bin, k, a);
    for (const ghost of this.ghosts) this.place(ghost, (ghost as Bin & { ghostK: number }).ghostK, a);
    return moving;
  }

  /** How dim a crate is: 0 for the active one, up to 35% for neighbours. */
  dimFor(k: number): number {
    return tuning.crate.neighbourDim * Math.min(1, Math.abs(k - this.active.value));
  }

  /** 1 for the active crate, easing to 0 one crate away (used to calm the fan in neighbours). */
  activeness(k: number): number {
    return Math.max(0, 1 - Math.abs(k - this.active.value));
  }

  presenceFor(k: number): number {
    return this.bins.get(k)?.presence.value ?? 0;
  }

  /** World matrix of crate k's interior frame (origin at the floor centre, +z toward the camera). */
  matrixFor(
    k: number,
    out: Matrix4,
    presence = this.presenceFor(k),
    side = Math.sign(k - this.active.value) || 1,
  ): Matrix4 {
    const c = tuning.crate;
    const r = k - this.active.value;
    const slide = (1 - presence) * 0.35 * side;
    const turn = -Math.max(-1, Math.min(1, r)) * c.inwardTurn * DEG;
    this.tmpE.set(c.tilt * DEG, turn, 0, 'YXZ');
    this.tmpQ.setFromEuler(this.tmpE);
    // Neighbours sit a little further back so their inward turn does not crowd the active bin.
    this.tmpV.set(
      r * c.spacing + slide,
      c.floorY - (1 - presence) * 0.05,
      c.rowZ - Math.min(1, Math.abs(r)) * 0.08,
    );
    return out.compose(this.tmpV, this.tmpQ, this.one);
  }

  private place(bin: Bin, k: number, a: number): void {
    this.matrixFor(k, bin.group.matrix, bin.presence.value, bin.side);
    bin.group.matrixWorldNeedsUpdate = true;
    const dim = tuning.crate.neighbourDim * Math.min(1, Math.abs(k - a));
    bin.material.dim = dim;
    bin.material.opacity2 = bin.presence.value;
    bin.group.visible = bin.presence.value > 0.01;
  }

  /** Redraw bin labels (after the hand-lettering font loads). */
  refreshLabels(): void {
    for (const bin of [...this.bins.values(), ...this.ghosts]) bin.setLabel(bin.label, true);
  }

  /** Crate indices whose bins are drawn (for record rendering). */
  visibleCrates(): number[] {
    return [...this.bins.keys()].sort((x, y) => x - y);
  }

  dispose(): void {
    for (const bin of [...this.bins.values(), ...this.ghosts, ...this.pool]) bin.dispose();
    this.geometry.dispose();
    this.woodMap.dispose();
    this.shadowMat.map?.dispose();
    this.shadowMat.dispose();
  }
}
