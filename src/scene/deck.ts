/**
 * The play ritual. A held record is sent to the turntable:
 *   1. the disc slides out of its sleeve (400 ms, ease-out)
 *   2. the sleeve arcs to a small easel beside the deck, cover to the room (700 ms); its crate slot
 *      stays open as a soft gap
 *   3. the disc arcs to the platter and settles with a 2 mm overshoot (600 ms)
 *   4. the platter spins up to 33 1/3 rpm over 1.2 s, ease-in
 *   5. the tonearm lifts, swings over the edge (700 ms) and lowers (300 ms): needle drop
 *   6. while playing the arm drifts inward with track progress and the light streaks travel
 * Pause lifts the arm and spins down over 2 s; stop puts everything back along the reverse path. Loading
 * another record while one plays runs put-away then play, back to back. Commands are serialised, so the
 * ritual never overlaps itself; all motion runs on frame-driven tweens, so nothing pops.
 */

import { BoxGeometry, Group, Mesh, Quaternion, type Scene, Vector3 } from 'three';
import type { Album } from '../data/types';
import { EASE, type Easing, clamp01 } from '../motion/easing';
import { Clock, Tween } from '../motion/tween';
import type { PlaybackAdapter, PlaybackState } from '../playback/adapter';
import { LitMaterial } from './materials';
import type { HoldController, Pose } from './hold';
import type { RecordEntity, RecordSystem } from './records';
import { LP_SIZE } from './records';
import { ROOM } from './room';
import { DECK, type Turntable } from './turntable';
import { VinylDisc } from './vinyl';

const DEG = Math.PI / 180;
/** 33 1/3 rpm = 200 degrees per second. */
const OMEGA = 200 * DEG;

export type DeckPhase = 'empty' | 'loading' | 'playing' | 'paused' | 'ended' | 'unloading';

export interface DeckEvents {
  onPhase?(phase: DeckPhase, album: Album | null): void;
  onNeedleDrop?(): void;
  onNeedleLift?(): void;
  onPaperSlide?(): void;
}

type SleeveMode = 'hand' | 'toEasel' | 'easel' | 'toSlot';
type DiscMode = 'hidden' | 'sleeve' | 'toPlatter' | 'platter' | 'toSleeve';

const newPose = (): Pose => ({ position: new Vector3(), quaternion: new Quaternion() });

export class Deck {
  phase: DeckPhase = 'empty';
  entity: RecordEntity | null = null;
  readonly disc: VinylDisc;
  readonly spin = new Tween(0);
  readonly armYaw: Tween;
  readonly armLift = new Tween(0);
  readonly sleeveT = new Tween(0);
  readonly discSlide = new Tween(0);
  readonly discT = new Tween(0);
  private clock = new Clock();
  private angle = 0;
  private streakWorld = 0.7;
  private sleeveMode: SleeveMode = 'hand';
  private discMode: DiscMode = 'hidden';
  private handPose = newPose();
  private easelPose = newPose();
  private slotPose = newPose();
  private lastSlot = newPose();
  private discFrom = newPose();
  private sleevePose = newPose();
  private tmpPose = newPose();
  private tmpQ = new Quaternion();
  private tmpV = new Vector3();
  private armTrack = false;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  private easel: Group;
  private easelMaterial: LitMaterial;
  reducedMotion = false;

  constructor(
    scene: Scene,
    private turntable: Turntable,
    private records: RecordSystem,
    private hold: HoldController,
    private adapter: PlaybackAdapter,
    private events: DeckEvents = {},
  ) {
    this.disc = new VinylDisc(scene);
    this.armYaw = new Tween(DECK.restYaw);
    this.easelMaterial = new LitMaterial({ color: '#6b4428', roughness: 0.7, specular: 0.15 });
    this.easel = this.buildEasel();
    scene.add(this.easel);
    this.computeEaselPose();
    this.unsubscribe = adapter.subscribe((s) => this.onAdapter(s));
  }

  get album(): Album | null {
    return this.entity?.album ?? null;
  }

  get moving(): boolean {
    return (
      this.spin.value > 0 ||
      this.spin.active ||
      this.armYaw.active ||
      this.armLift.active ||
      this.sleeveT.active ||
      this.discSlide.active ||
      this.discT.active ||
      this.clock.pending
    );
  }

  // --- commands ----------------------------------------------------------------------------------------

  /** Send the held record to the turntable (Space / Play). */
  playHeld(): void {
    this.enqueue(async () => {
      if (!this.hold.entity || this.hold.phase === 'returning') return;
      if (this.entity) await this.putAway();
      await this.load();
    });
  }

  togglePause(): void {
    this.enqueue(async () => {
      if (this.phase === 'playing') await this.pause();
      else if (this.phase === 'paused') await this.resume();
      else if (this.phase === 'ended') await this.replay();
    });
  }

  stopAndPutAway(): void {
    this.enqueue(async () => {
      if (this.entity) await this.putAway();
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err) => console.error('deck:', err));
  }

  // --- sequences ---------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    const handed = this.hold.handoff();
    if (!handed) return;
    const e = handed.entity;
    this.entity = e;
    this.handPose.position.copy(handed.pose.position);
    // The hand pose already includes a flip; the arc to the easel turns the cover back to the room.
    this.handPose.quaternion.copy(handed.pose.quaternion);
    this.sleeveMode = 'hand';
    this.sleeveT.snap(0);
    e.override = (out) => this.sleevePoseFn(out);
    this.records.wake(e);
    this.disc.setAlbum(e.album);
    this.discMode = 'sleeve';
    this.discSlide.snap(0);
    this.setPhase('loading');

    // 1. Disc slides out of the sleeve.
    this.events.onPaperSlide?.();
    await this.run(this.discSlide, 1, 400, EASE.out);
    // 2 + 3. Sleeve to the easel; the disc follows a beat later to the platter.
    this.sleeveMode = 'toEasel';
    const sleeveDone = this.run(this.sleeveT, 1, 700, EASE.inOut);
    await this.clock.wait(this.reducedMotion ? 0 : 180);
    this.captureDisc();
    this.discMode = 'toPlatter';
    this.discT.snap(0);
    await Promise.all([sleeveDone, this.run(this.discT, 1, 600, EASE.out)]);
    this.sleeveMode = 'easel';
    this.discMode = 'platter';
    // 4 + 5. Spin up, then the needle drop.
    await this.run(this.spin, 1, 1200, EASE.in);
    await this.dropNeedle();
    await this.adapter.play(e.album.uri);
    this.armTrack = true;
    this.setPhase('playing');
  }

  private async dropNeedle(): Promise<void> {
    await this.run(this.armLift, 1, 220, EASE.out);
    await this.run(this.armYaw, this.turntable.leadInYaw, 700, EASE.inOut);
    await this.run(this.armLift, 0, 300, EASE.out);
    this.events.onNeedleDrop?.();
  }

  /** `fromAdapter`: playback was paused elsewhere (Spotify app, media keys); only the room follows. */
  private async pause(fromAdapter = false): Promise<void> {
    if (this.phase !== 'playing') return;
    this.armTrack = false;
    this.setPhase('paused');
    if (!fromAdapter) await this.adapter.pause();
    this.events.onNeedleLift?.();
    this.spin.start(0, 2000, EASE.out);
    await this.run(this.armLift, 1, 300, EASE.out);
  }

  private async resume(fromAdapter = false): Promise<void> {
    if (this.phase !== 'paused') return;
    await this.run(this.spin, 1, 1200, EASE.in);
    await this.run(this.armLift, 0, 300, EASE.out);
    this.events.onNeedleDrop?.();
    if (!fromAdapter) await this.adapter.resume();
    this.armTrack = true;
    this.setPhase('playing');
  }

  private async replay(): Promise<void> {
    if (!this.entity) return;
    this.setPhase('loading');
    await this.run(this.spin, 1, 1200, EASE.in);
    await this.dropNeedle();
    await this.adapter.play(this.entity.album.uri);
    this.armTrack = true;
    this.setPhase('playing');
  }

  /** Auto-return at the end of the album: the arm goes home, the platter stops, the record stays. */
  private async autoReturn(): Promise<void> {
    if (this.phase !== 'playing') return;
    this.armTrack = false;
    this.setPhase('ended');
    this.events.onNeedleLift?.();
    this.spin.start(0, 2000, EASE.out);
    await this.run(this.armLift, 1, 300, EASE.out);
    await this.run(this.armYaw, DECK.restYaw, 700, EASE.inOut);
    await this.run(this.armLift, 0, 300, EASE.out);
  }

  private async putAway(): Promise<void> {
    const e = this.entity;
    if (!e) return;
    this.setPhase('unloading');
    this.armTrack = false;
    await this.adapter.stop();
    this.events.onNeedleLift?.();
    this.spin.start(0, 2000, EASE.out);
    await this.run(this.armLift, 1, this.armLift.value > 0.99 ? 0 : 300, EASE.out);
    const armHome = this.run(this.armYaw, DECK.restYaw, 700, EASE.inOut).then(() =>
      this.run(this.armLift, 0, 300, EASE.out),
    );
    await this.clock.wait(this.reducedMotion ? 0 : 320);
    // Disc back to its sleeve on the easel, then in.
    this.captureDisc();
    this.discMode = 'toSleeve';
    this.discSlide.snap(1);
    this.discT.snap(0);
    await this.run(this.discT, 1, 600, EASE.inOut);
    this.discMode = 'sleeve';
    this.events.onPaperSlide?.();
    await this.run(this.discSlide, 0, 400, EASE.inOut);
    this.discMode = 'hidden';
    this.disc.setAlbum(null);
    // Sleeve back to its crate slot along the reverse path.
    this.sleeveMode = 'toSlot';
    this.sleeveT.snap(0);
    await this.run(this.sleeveT, 1, 700, EASE.inOut);
    e.override = null;
    this.records.wake(e);
    this.entity = null;
    this.setPhase('empty');
    await armHome;
  }

  private run(t: Tween, to: number, ms: number, easing: Easing): Promise<void> {
    return new Promise((resolve) => {
      const dur = this.reducedMotion ? Math.min(ms, 120) : ms;
      if (Math.abs(t.value - to) < 1e-6 && !t.active) {
        t.snap(to);
        resolve();
        return;
      }
      t.start(to, dur, easing, { onDone: resolve });
    });
  }

  private setPhase(phase: DeckPhase): void {
    this.phase = phase;
    this.events.onPhase?.(phase, this.album);
  }

  private onAdapter(s: PlaybackState): void {
    if (s.status === 'ended' && this.phase === 'playing') this.enqueue(() => this.autoReturn());
    // Real playback can also be paused or resumed outside the room; the phase guards in pause/resume make
    // these no-ops when the room itself started the change.
    else if (s.status === 'paused' && this.phase === 'playing') this.enqueue(() => this.pause(true));
    else if (s.status === 'playing' && this.phase === 'paused') this.enqueue(() => this.resume(true));
  }

  // --- per frame ---------------------------------------------------------------------------------------

  update(dt: number): void {
    this.clock.advance(dt);
    for (const t of [this.spin, this.armYaw, this.armLift, this.sleeveT, this.discSlide, this.discT])
      t.update(dt);
    const omega = OMEGA * this.spin.value;
    this.angle = (this.angle + omega * dt) % (Math.PI * 2);
    // The light streak rides with the disc while it turns and stays put in the world when it is still.
    this.streakWorld += omega * dt * this.spin.value;
    this.turntable.setPlatterAngle(this.angle);

    if (this.armTrack) {
      const s = this.adapter.getState();
      const p = s.durationMs > 0 ? clamp01(s.positionMs / s.durationMs) : 0;
      this.armYaw.snap(this.turntable.leadInYaw + (this.turntable.runOutYaw - this.turntable.leadInYaw) * p);
    }
    this.turntable.setArm(this.armYaw.value, this.armLift.value);
    this.placeDisc();
  }

  // --- poses -------------------------------------------------------------------------------------------

  private computeEaselPose(): void {
    const p = ROOM.easel;
    this.easelPose.position.set(p.x, p.y + 0.028, p.z + 0.03);
    // Lean back and turn a little toward the camera, cover facing the room.
    const yaw = Math.atan2(-p.x, 2.9) * 0.8;
    this.easelPose.quaternion
      .setFromAxisAngle(new Vector3(0, 1, 0), yaw)
      .multiply(this.tmpQ.setFromAxisAngle(new Vector3(1, 0, 0), -18 * DEG));
  }

  private buildEasel(): Group {
    const g = new Group();
    const p = ROOM.easel;
    const m = this.easelMaterial;
    const base = new Mesh(new BoxGeometry(0.2, 0.012, 0.09), m);
    base.position.set(p.x, p.y + 0.006, p.z + 0.01);
    const ledge = new Mesh(new BoxGeometry(0.22, 0.022, 0.018), m);
    ledge.position.set(p.x, p.y + 0.02, p.z + 0.05);
    const back = new Mesh(new BoxGeometry(0.026, 0.13, 0.012), m);
    back.position.set(p.x, p.y + 0.065, p.z - 0.02);
    back.rotation.x = -14 * DEG;
    g.add(base, ledge, back);
    g.rotation.y = 0;
    return g;
  }

  private bezier(from: Pose, to: Pose, t: number, lift: number, out: Pose): Pose {
    const c = this.tmpV.copy(from.position).lerp(to.position, 0.5);
    c.y = Math.max(from.position.y, to.position.y) + lift;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const d = t * t;
    out.position.set(
      from.position.x * a + c.x * b + to.position.x * d,
      from.position.y * a + c.y * b + to.position.y * d,
      from.position.z * a + c.z * b + to.position.z * d,
    );
    out.quaternion.copy(from.quaternion).slerp(to.quaternion, t);
    return out;
  }

  /** Where the sleeve on deck is right now (used as the record system's pose override). */
  private sleevePoseFn(out: Pose): void {
    switch (this.sleeveMode) {
      case 'hand':
        out.position.copy(this.handPose.position);
        out.quaternion.copy(this.handPose.quaternion);
        break;
      case 'toEasel':
        this.bezier(this.handPose, this.easelPose, this.sleeveT.value, 0.12, out);
        break;
      case 'easel':
        out.position.copy(this.easelPose.position);
        out.quaternion.copy(this.easelPose.quaternion);
        break;
      case 'toSlot': {
        const e = this.entity;
        if (e && this.records.slotPose(e, this.slotPose)) {
          this.lastSlot.position.copy(this.slotPose.position);
          this.lastSlot.quaternion.copy(this.slotPose.quaternion);
        } else {
          // Filtered out while it was playing: it goes back toward the crate and sinks out of sight.
          this.slotPose.position.set(0, 0.35, -1.5);
          this.slotPose.quaternion.copy(this.easelPose.quaternion);
        }
        this.bezier(this.easelPose, this.slotPose, this.sleeveT.value, 0.3, out);
        break;
      }
    }
    this.sleevePose.position.copy(out.position);
    this.sleevePose.quaternion.copy(out.quaternion);
  }

  /** Disc standing inside the sleeve, slid out along the sleeve's +x by `slide`. */
  private discInSleeve(sleeve: Pose, slide: number, out: Pose): Pose {
    this.tmpV.set(slide * (LP_SIZE + 0.02), LP_SIZE / 2, -0.0005).applyQuaternion(sleeve.quaternion);
    out.position.copy(sleeve.position).add(this.tmpV);
    out.quaternion
      .copy(sleeve.quaternion)
      .multiply(this.tmpQ.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
    return out;
  }

  private captureDisc(): void {
    if (this.discMode === 'platter') this.turntable.discPose(this.angle, this.discFrom);
    else this.discInSleeve(this.sleevePose, 1, this.discFrom);
  }

  private placeDisc(): void {
    const mesh = this.disc.mesh;
    if (this.discMode === 'hidden' || !this.entity) {
      mesh.visible = false;
      return;
    }
    const out = this.tmpPose;
    const u = this.disc.material.uniforms;
    switch (this.discMode) {
      case 'sleeve':
        this.discInSleeve(this.sleevePose, this.discSlide.value, out);
        u.uStreak.value = 0.9;
        break;
      case 'toPlatter': {
        const target = newPose();
        const t = this.discT.value;
        // Settles with a 2 mm overshoot below the mat, then rises back.
        const settle = t > 0.8 ? -0.002 * Math.sin(Math.PI * clamp01((t - 0.8) / 0.2)) : 0;
        this.turntable.discPose(this.angle, target, settle);
        this.bezier(this.discFrom, target, t, 0.14, out);
        u.uStreak.value = this.streakWorld - this.angle;
        break;
      }
      case 'platter':
        this.turntable.discPose(this.angle, out);
        u.uStreak.value = this.streakWorld - this.angle;
        break;
      case 'toSleeve': {
        const target = this.discInSleeve(this.sleevePose, 1, newPose());
        this.bezier(this.discFrom, target, this.discT.value, 0.14, out);
        u.uStreak.value = 0.9;
        break;
      }
    }
    // Hidden while fully inside the sleeve (it would z-fight with the sleeve faces).
    mesh.visible = !(this.discMode === 'sleeve' && this.discSlide.value < 0.02);
    mesh.matrix.compose(out.position, out.quaternion, this.tmpV.set(1, 1, 1));
    mesh.matrixWorld.copy(mesh.matrix);
  }

  /** Is this object part of the tonearm (click to pause)? */
  isArm(object: unknown): boolean {
    return this.turntable.pickables.includes(object as Mesh);
  }

  dispose(): void {
    this.unsubscribe();
    this.disc.dispose();
    this.easelMaterial.dispose();
    this.easel.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
  }
}
