/**
 * The hold state: the focused record arcs out and up to screen centre (~1.6x its size in the crate),
 * floats with a 2 degree sway that follows the pointer, flips to its back (F), and returns along the
 * reverse arc (Esc / click outside). While held the room dims 25% and blurs (see post.ts).
 */

import { Quaternion, Vector3 } from 'three';
import type { Album } from '../data/types';
import { EASE, clamp01 } from '../motion/easing';
import { Spring } from '../motion/spring';
import { Tween } from '../motion/tween';
import type { CameraRig } from './camera';
import { LP_SIZE, type RecordEntity, type RecordSystem } from './records';
import { canvasToTexture, sleeveBackCanvas } from './sleeveArt';
import { tuning } from './tuning';

const DEG = Math.PI / 180;
const critical = (k: number) => ({ stiffness: k, damping: 2 * Math.sqrt(k) });

export type HoldPhase = 'idle' | 'pulling' | 'held' | 'returning';

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
}

export class HoldController {
  phase: HoldPhase = 'idle';
  entity: RecordEntity | null = null;
  readonly t = new Tween(0);
  readonly flip = new Tween(0);
  readonly dim = new Tween(0);
  readonly swayX = new Spring(0, critical(55));
  readonly swayY = new Spring(0, critical(55));
  flipped = false;
  reducedMotion = false;
  private flipFrom = 0;
  private flipTo = 0;
  private slot: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  private hold: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  private lastSlot: Pose = { position: new Vector3(), quaternion: new Quaternion() };
  private ctrl = new Vector3();
  private tmp = new Vector3();
  private tmpQ = new Quaternion();
  private yAxis = new Vector3(0, 1, 0);
  private xAxis = new Vector3(1, 0, 0);
  /** Called when a record finishes returning to its crate. */
  onReturned: ((e: RecordEntity) => void) | null = null;
  onPhase: ((phase: HoldPhase, album: Album | null, flipped: boolean) => void) | null = null;

  constructor(
    private records: RecordSystem,
    private rig: CameraRig,
    private loadTracks: (album: Album) => Promise<Album['tracks']>,
  ) {}

  get active(): boolean {
    return this.phase !== 'idle';
  }

  get moving(): boolean {
    return (
      this.t.active ||
      this.flip.active ||
      this.dim.active ||
      !this.swayX.isAtRest(1e-3) ||
      !this.swayY.isAtRest(1e-3)
    );
  }

  pull(e: RecordEntity): void {
    if (this.entity && this.entity !== e) return;
    this.entity = e;
    this.flipped = false;
    this.flip.snap(0);
    this.phase = 'pulling';
    e.override = (out) => this.pose(out);
    this.records.wake(e);
    const ms = this.reducedMotion ? 120 : tuning.hold.pullMs;
    this.t.start(1, ms, this.reducedMotion ? EASE.inOut : EASE.pull, {
      onDone: () => {
        if (this.phase === 'pulling') this.setPhase('held');
      },
    });
    this.dim.start(1, tuning.hold.dimMs, EASE.inOut);
    this.rig.setHolding(true);
    this.setPhase('pulling');
    // The back is generated lazily; fonts are loaded by the time anyone can flip it.
    void this.loadTracks(e.album).then((tracks) => {
      if (this.entity !== e) return;
      const tex = canvasToTexture(sleeveBackCanvas(e.album, tracks ?? null));
      this.records.setBackTexture(e, tex);
    });
  }

  release(): void {
    const e = this.entity;
    if (!e || this.phase === 'returning') return;
    this.phase = 'returning';
    if (this.flipped) this.toggleFlip();
    const ms = this.reducedMotion ? 120 : tuning.hold.returnMs;
    this.t.start(0, ms, EASE.inOut, { onDone: () => this.finishReturn() });
    this.dim.start(0, tuning.hold.dimMs, EASE.inOut);
    this.rig.setHolding(false);
    this.setPhase('returning');
  }

  private finishReturn(): void {
    const e = this.entity;
    if (!e) return;
    e.override = null;
    const back = e.backTexture;
    this.records.setBackTexture(e, null);
    back?.dispose();
    this.entity = null;
    this.phase = 'idle';
    this.setPhase('idle');
    this.onReturned?.(e);
  }

  /**
   * Hand the held record to the deck: returns its current pose, and the deck takes over the override.
   * The room un-dims as the sleeve leaves your hands.
   */
  handoff(): { entity: RecordEntity; pose: Pose; flipped: boolean } | null {
    const e = this.entity;
    if (!e || this.phase === 'returning') return null;
    const pose: Pose = { position: new Vector3(), quaternion: new Quaternion() };
    this.pose(pose);
    const flipped = this.flipped;
    const back = e.backTexture;
    e.override = null;
    this.records.setBackTexture(e, null);
    back?.dispose();
    this.entity = null;
    this.phase = 'idle';
    this.t.snap(0);
    this.flip.snap(0);
    this.flipped = false;
    this.dim.start(0, tuning.hold.dimMs, EASE.inOut);
    this.rig.setHolding(false);
    this.setPhase('idle');
    return { entity: e, pose, flipped };
  }

  toggleFlip(): void {
    if (!this.entity || this.phase === 'idle') return;
    this.flipped = !this.flipped;
    this.flipFrom = this.currentFlipAngle();
    this.flipTo = this.flipped ? Math.PI : 0;
    const ms = this.reducedMotion ? 120 : tuning.hold.flipMs;
    this.flip.start(1, ms, this.reducedMotion ? EASE.inOut : EASE.flip, { from: 0 });
    this.onPhase?.(this.phase, this.entity.album, this.flipped);
  }

  private currentFlipAngle(): number {
    const p = this.flip.value;
    return this.flipFrom + (this.flipTo - this.flipFrom) * p + this.overshoot();
  }

  /** A 3 degree overshoot past the target that settles back, peaking late in the flip. */
  private overshoot(): number {
    if (!this.flip.active || this.reducedMotion) return 0;
    const t = clamp01(this.flip.elapsed / Math.max(1e-3, this.flip.duration));
    const bump = Math.sin(Math.PI * clamp01((t - 0.45) / 0.55));
    return Math.sign(this.flipTo - this.flipFrom) * tuning.hold.flipOvershoot * DEG * bump;
  }

  setPointer(x: number, y: number): void {
    const s = this.reducedMotion ? 0 : tuning.hold.sway;
    this.swayX.target = x * s;
    this.swayY.target = y * s;
  }

  fixedUpdate(dt: number): void {
    this.swayX.step(dt);
    this.swayY.step(dt);
  }

  update(dt: number): void {
    this.t.update(dt);
    this.flip.update(dt);
    this.dim.update(dt);
  }

  private setPhase(phase: HoldPhase): void {
    this.phase = phase;
    this.onPhase?.(phase, this.entity?.album ?? null, this.flipped);
  }

  /** Where the held record floats: camera-relative, facing the viewer, bottom-centre origin. */
  holdPose(out: Pose): Pose {
    const cam = this.rig.camera;
    const d = this.rig.holdDistance(LP_SIZE, tuning.hold.screenFill);
    const forward = this.tmp.set(0, 0, -1).applyQuaternion(cam.quaternion);
    out.position.copy(cam.position).addScaledVector(forward, d);
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    out.position.addScaledVector(up, -LP_SIZE / 2);
    out.quaternion.copy(cam.quaternion);
    return out;
  }

  /** The pose override used by the record system while this record is held. */
  pose(out: Pose): void {
    const e = this.entity;
    if (!e) return;
    if (this.records.slotPose(e, this.slot)) {
      this.lastSlot.position.copy(this.slot.position);
      this.lastSlot.quaternion.copy(this.slot.quaternion);
    } else {
      // The record was filtered out while held: return toward where it last stood, sinking.
      this.slot.position.copy(this.lastSlot.position).add(new Vector3(0, -0.15, 0));
      this.slot.quaternion.copy(this.lastSlot.quaternion);
    }
    this.holdPose(this.hold);
    const k = this.t.value;
    // Arc out and up: a quadratic Bezier whose control point rises above the crate.
    this.ctrl.copy(this.slot.position).lerp(this.hold.position, 0.35);
    this.ctrl.y = Math.max(this.slot.position.y, this.hold.position.y) + 0.22;
    const a = (1 - k) * (1 - k);
    const b = 2 * (1 - k) * k;
    const c = k * k;
    out.position
      .copy(this.slot.position)
      .multiplyScalar(a)
      .addScaledVector(this.ctrl, b)
      .addScaledVector(this.hold.position, c);
    out.quaternion.copy(this.slot.quaternion).slerp(this.hold.quaternion, Math.min(1, k * 1.15));
    // Sway follows the pointer; the flip turns about the record's vertical axis.
    const sway = this.tmpQ.setFromAxisAngle(this.yAxis, this.swayX.value * DEG * k);
    out.quaternion.multiply(sway);
    out.quaternion.multiply(this.tmpQ.setFromAxisAngle(this.xAxis, -this.swayY.value * DEG * k));
    const angle = this.currentFlipAngle();
    if (angle !== 0) {
      // Rotate about the vertical centre line, which passes through the bottom-centre origin.
      out.quaternion.multiply(this.tmpQ.setFromAxisAngle(this.yAxis, angle));
    }
  }
}
