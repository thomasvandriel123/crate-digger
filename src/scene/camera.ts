/**
 * Fixed, slightly elevated camera: 35 degree vertical FOV, ~1.6 m high, pitched down 25 degrees. Pointer
 * parallax (at most 2 degrees yaw, 1 degree pitch, critically damped), a slow idle drift so the frame is
 * never dead, and one dolly move (12% closer) while a record is held. Phone portrait gets its own rig:
 * steeper (38 degrees), one crate wide, turntable in the top third.
 */

import { Euler, MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { EASE } from '../motion/easing';
import { Spring } from '../motion/spring';
import { Tween } from '../motion/tween';
import { tuning } from './tuning';

const DEG = Math.PI / 180;
const critical = (k: number) => ({ stiffness: k, damping: 2 * Math.sqrt(k) });

export class CameraRig {
  readonly camera: PerspectiveCamera;
  readonly yaw = new Spring(0, critical(38));
  readonly pitch = new Spring(0, critical(38));
  readonly dolly = new Tween(0);
  readonly truck = new Tween(0);
  portrait = false;
  reducedMotion = false;
  private time = 0;
  private basePos = new Vector3();
  private basePitch = tuning.camera.pitch;
  private target = new Vector3();
  private euler = new Euler(0, 0, 0, 'YXZ');
  private q = new Quaternion();
  aspect = 16 / 9;

  constructor() {
    this.camera = new PerspectiveCamera(tuning.camera.fov, 16 / 9, 0.05, 40);
    this.resize(1600, 900);
  }

  resize(width: number, height: number): void {
    const c = tuning.camera;
    this.aspect = width / Math.max(1, height);
    this.portrait = this.aspect < 0.78;
    const rowZ = tuning.crate.rowZ;
    // Aim into the bins: standing at the crates, the active bin's front sits near the bottom edge, three
    // bins fit across, and the sideboard with lamp and turntable fills the upper third. Spec eye height,
    // pitch and lens; the distance follows from them.
    const lookY = tuning.crate.floorY + (this.aspect < 0.78 ? 0.2 : 0.22);
    if (this.portrait) {
      // Phone portrait: one crate filling the lower two thirds, the turntable in the top third. Standing
      // closer and steeper, with a tall lens so the sideboard stays in frame.
      this.basePitch = c.portraitPitch;
      this.basePos.set(0.05, c.portraitHeight, rowZ + 1.2);
      this.target.set(0.05, lookY, rowZ);
      const hHalf = 14 * DEG;
      this.camera.fov = Math.min(80, Math.max(45, (2 * Math.atan(Math.tan(hHalf) / this.aspect)) / DEG));
      this.camera.aspect = this.aspect;
      this.camera.updateProjectionMatrix();
      return;
    } else {
      this.basePitch = c.pitch;
      const dist = (c.height - lookY) / Math.tan(this.basePitch * DEG);
      this.basePos.set(0, c.height, rowZ + dist);
    }
    this.target.set(0, lookY, rowZ);
    // Horizontal FOV adapts so the crate row (or the single crate in portrait) always fits.
    const along = this.basePos.distanceTo(this.target);
    const halfWidth = this.portrait
      ? tuning.crate.innerWidth / 2 + 0.07
      : tuning.crate.spacing + tuning.crate.innerWidth / 2 + 0.12;
    const hHalf = Math.atan(halfWidth / along);
    const vFromH = (2 * Math.atan(Math.tan(hHalf) / this.aspect)) / DEG;
    this.camera.fov = Math.min(70, Math.max(c.fov, vFromH));
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Pointer in normalised device coordinates (-1..1). */
  setPointer(x: number, y: number): void {
    if (this.reducedMotion) {
      this.yaw.target = 0;
      this.pitch.target = 0;
      return;
    }
    this.yaw.target = -x * tuning.camera.parallaxYaw;
    this.pitch.target = y * tuning.camera.parallaxPitch;
  }

  setHolding(holding: boolean): void {
    const to = holding ? 1 : 0;
    if (this.dolly.to === to && (this.dolly.active || this.dolly.value === to)) return;
    if (this.reducedMotion) this.dolly.snap(to);
    else this.dolly.start(to, holding ? 550 : 500, holding ? EASE.pull : EASE.inOut);
  }

  /** A small truck in the direction of a crate switch, easing back: the row slides, the eye follows. */
  nudge(direction: number): void {
    if (this.reducedMotion) return;
    this.truck.start(direction * 0.035, 280, EASE.out, {
      onDone: () => this.truck.start(0, 520, EASE.inOut),
    });
  }

  fixedUpdate(dt: number): void {
    this.yaw.step(dt);
    this.pitch.step(dt);
  }

  get moving(): boolean {
    return !this.yaw.isAtRest(1e-3) || !this.pitch.isAtRest(1e-3) || this.dolly.active || this.truck.active;
  }

  update(dt: number): void {
    this.time += dt;
    this.dolly.update(dt);
    this.truck.update(dt);
    const c = tuning.camera;
    let driftYaw = 0;
    let driftPitch = 0;
    if (!this.reducedMotion) {
      const t = this.time;
      driftYaw = c.driftDeg * Math.sin((2 * Math.PI * t) / c.driftPeriod) * 0.8;
      driftPitch = c.driftDeg * 0.5 * Math.sin((2 * Math.PI * t) / (c.driftPeriod * 1.37) + 1.1);
    }
    const pitch = this.basePitch + this.pitch.value + driftPitch;
    const yaw = this.yaw.value + driftYaw;
    this.euler.set(-pitch * DEG, yaw * DEG, 0, 'YXZ');
    this.q.setFromEuler(this.euler);
    this.camera.quaternion.copy(this.q);
    const dollyAmount = MathUtils.clamp(this.dolly.value, 0, 1.2) * c.dolly;
    this.camera.position.copy(this.basePos).lerp(this.target, dollyAmount);
    this.camera.position.x += this.truck.value;
    this.camera.updateMatrixWorld();
  }

  /** Distance at which a record of `size` fills `fill` of the view (height, and width in portrait). */
  holdDistance(size: number, fill: number): number {
    const tanV = Math.tan((this.camera.fov * DEG) / 2);
    const byHeight = size / (2 * fill * tanV);
    const byWidth = size / (2 * Math.min(0.82, fill * 1.6) * tanV * this.aspect);
    return Math.max(byHeight, byWidth);
  }

  /** Amount of sheen phase contributed by camera drift and parallax (for the cover sheen). */
  get sheenPhase(): number {
    return (this.yaw.value + this.pitch.value) * 0.08 + Math.sin(this.time * 0.07) * 0.05;
  }
}
