/**
 * Plastic divider cards at group boundaries (letters, decades, months, hue names). They stand in the fan
 * like zero-thickness records, with a printed tab 3 cm above the sleeves. All dividers in view are one
 * instanced draw; tab labels live in a shared canvas atlas.
 */

import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  type Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DividerMaterial } from './materials';
import type { DividerInstance } from './records';
import { LP_SIZE } from './records';
import { type Canvas, ctx2d, makeCanvas } from './textures';

const CARD_W = 0.3;
/** The card body stays below the sleeves' tops so it never hides a cover; only the tab flag rises above. */
const CARD_H = 0.2;
const TAB_W = 0.085;
/** Tab reaches 3 cm above the records. */
const TAB_H = LP_SIZE + 0.03 - CARD_H;
const THICK = 0.0015;
const COLS = 8;
const ROWS = 20;
const CELL_W = 128;
const CELL_H = 48;
const MAX = 160;

function cardGeometry(): BufferGeometry {
  const card = new BoxGeometry(CARD_W, CARD_H, THICK);
  card.translate(0, CARD_H / 2, 0);
  card.setAttribute(
    'aIsTab',
    new Float32BufferAttribute(new Float32Array(card.getAttribute('position').count), 1),
  );
  // The flag: a plain stem, and the printed label area on top (only it gets atlas UVs).
  const LABEL_H = 0.036;
  const stem = new BoxGeometry(TAB_W, TAB_H - LABEL_H, THICK);
  stem.translate(0, CARD_H - 0.002 + (TAB_H - LABEL_H) / 2, 0);
  const stemUv = stem.getAttribute('uv');
  for (let i = 0; i < stemUv.count; i++) stemUv.setXY(i, 0, 0);
  stem.setAttribute(
    'aIsTab',
    new Float32BufferAttribute(new Float32Array(stem.getAttribute('position').count).fill(1), 1),
  );
  const tab = new BoxGeometry(TAB_W, LABEL_H, THICK);
  tab.translate(0, CARD_H - 0.002 + TAB_H - LABEL_H / 2, 0);
  tab.setAttribute(
    'aIsTab',
    new Float32BufferAttribute(new Float32Array(tab.getAttribute('position').count).fill(1), 1),
  );
  const merged = mergeGeometries([card, stem, tab], false);
  card.dispose();
  stem.dispose();
  tab.dispose();
  return merged;
}

export class DividerSystem {
  readonly mesh: InstancedMesh;
  private atlas: Canvas;
  private texture: CanvasTexture;
  private cells = new Map<string, number>();
  private aCell: InstancedBufferAttribute;
  private aTab: InstancedBufferAttribute;
  private aDim: InstancedBufferAttribute;
  private aColor: InstancedBufferAttribute;
  private m = new Matrix4();
  private one = new Vector3(1, 1, 1);
  private tint = new Color();
  /** Optional per-label card tint (the colour sweep tints its dividers with the hue they mark). */
  tintFor: ((label: string) => string | null) | null = null;

  constructor(scene: Scene) {
    this.atlas = makeCanvas(COLS * CELL_W, ROWS * CELL_H);
    this.texture = new CanvasTexture(this.atlas as HTMLCanvasElement);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    const geometry = cardGeometry();
    this.aCell = new InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(DynamicDrawUsage);
    this.aTab = new InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(DynamicDrawUsage);
    this.aDim = new InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(DynamicDrawUsage);
    this.aColor = new InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(DynamicDrawUsage);
    geometry.setAttribute('aCell', this.aCell);
    geometry.setAttribute('aTab', this.aTab);
    geometry.setAttribute('aDim', this.aDim);
    geometry.setAttribute('aColor', this.aColor);
    this.mesh = new InstancedMesh(geometry, new DividerMaterial(this.texture, new Vector2(COLS, ROWS)), MAX);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  private cellFor(label: string): number {
    let cell = this.cells.get(label);
    if (cell !== undefined) return cell;
    if (this.cells.size >= COLS * ROWS) {
      this.cells.clear();
      ctx2d(this.atlas).clearRect(0, 0, COLS * CELL_W, ROWS * CELL_H);
    }
    cell = this.cells.size;
    this.cells.set(label, cell);
    this.drawCell(cell, label);
    this.texture.needsUpdate = true;
    return cell;
  }

  private drawCell(cell: number, label: string): void {
    const ctx = ctx2d(this.atlas);
    const x = (cell % COLS) * CELL_W;
    const y = Math.floor(cell / COLS) * CELL_H;
    ctx.clearRect(x, y, CELL_W, CELL_H);
    ctx.fillStyle = 'rgba(28, 20, 16, 0.92)';
    let size = 30;
    const font = (s: number) => `700 ${s}px "Inter Variable", "Inter", system-ui, sans-serif`;
    ctx.font = font(size);
    while (ctx.measureText(label).width > CELL_W - 14 && size > 12) {
      size -= 2;
      ctx.font = font(size);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + CELL_W / 2, y + CELL_H / 2 + 2);
  }

  /** Redraw all labels (after fonts finish loading). */
  refreshFonts(): void {
    for (const [label, cell] of this.cells) this.drawCell(cell, label);
    this.texture.needsUpdate = true;
  }

  update(dividers: readonly DividerInstance[]): void {
    const n = Math.min(MAX, dividers.length);
    // Tabs sit at the card edges, so a divider in front of the focus only masks a corner of the cover.
    const tabOffsets = [-0.1, 0.1];
    for (let i = 0; i < n; i++) {
      const d = dividers[i]!;
      this.m.compose(d.position, d.quaternion, this.one);
      this.mesh.setMatrixAt(i, this.m);
      this.aCell.setX(i, this.cellFor(d.label));
      this.aTab.setX(i, tabOffsets[d.tab] ?? 0);
      this.aDim.setX(i, d.fade < 0.999 ? -(1 - d.fade) : d.dim);
      const tint = this.tintFor?.(d.label);
      if (tint) this.tint.set(tint);
      else this.tint.setRGB(0.8, 0.77, 0.7);
      this.aColor.setXYZ(i, this.tint.r, this.tint.g, this.tint.b);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aCell.needsUpdate = true;
    this.aTab.needsUpdate = true;
    this.aDim.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as DividerMaterial).dispose();
  }
}
