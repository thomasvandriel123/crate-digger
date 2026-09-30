/**
 * The deck: walnut plinth, matte black platter with a slip mat, an S-shaped tonearm with a visible
 * headshell, 33/45 buttons, a pitch slider and a hinged dust cover standing open. Simplified geometry,
 * well under 5,000 triangles. Real-time lit (LitMaterial) so it matches the records.
 */

import {
  BoxGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  TubeGeometry,
  Vector3,
} from 'three';
import { LitMaterial } from './materials';
import { blobTexture, paint, woodAlbedo } from './textures';

const DEG = Math.PI / 180;

export const DECK = {
  footH: 0.015,
  plinthH: 0.075,
  plateY: 0.094,
  platterCentre: new Vector3(-0.06, 0, 0.0),
  platterR: 0.148,
  platterH: 0.025,
  matH: 0.003,
  pivot: new Vector3(0.158, 0, -0.105),
  pivotH: 0.05,
  /** Needle position in the arm's local frame (rest = pointing toward the front, +z). */
  needle: new Vector3(-0.024, -0.03, 0.232),
  restYaw: 3,
  leadInRadius: 0.146,
  runOutRadius: 0.064,
  liftDeg: 4.5,
};

export class Turntable {
  readonly group = new Group();
  readonly platter = new Object3D();
  readonly armYaw = new Object3D();
  readonly armLift = new Object3D();
  readonly pickables: Mesh[] = [];
  /** Local y of the disc's centre when it lies on the mat. */
  readonly discY = DECK.plateY + DECK.platterH + DECK.matH + 0.001;
  readonly leadInYaw: number;
  readonly runOutYaw: number;
  private materials: LitMaterial[] = [];
  private tmp = new Vector3();

  constructor(position: Vector3) {
    this.group.name = 'turntable';
    this.group.position.copy(position);
    // Turn the deck slightly toward the camera so the arm and platter read in three-quarter view.
    this.group.rotation.y = -8 * DEG;

    const wood = new CanvasTexture(
      paint(256, 64, woodAlbedo(29, '#8a5a36', '#5e3a22', 1.2)) as HTMLCanvasElement,
    );
    wood.colorSpace = SRGBColorSpace;
    const walnut = this.mat({ map: wood, roughness: 0.55, specular: 0.25 });
    const black = this.mat({ color: '#141212', roughness: 0.45, specular: 0.35 });
    const plate = this.mat({ color: '#1c1a1a', roughness: 0.35, specular: 0.5 });
    const felt = this.mat({ color: '#2a2624', roughness: 0.95, specular: 0.02 });
    const alu = this.mat({ color: '#b9b4ab', roughness: 0.25, specular: 1.1 });
    const brass = this.mat({ color: '#b08a4a', roughness: 0.3, specular: 0.9 });

    const add = (
      geom: BoxGeometry | CylinderGeometry | TubeGeometry,
      material: LitMaterial,
      x: number,
      y: number,
      z: number,
      parent: Object3D = this.group,
    ) => {
      const m = new Mesh(geom, material);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // Plinth, top plate, feet.
    add(new BoxGeometry(0.45, DECK.plinthH, 0.36), walnut, 0, DECK.footH + DECK.plinthH / 2, 0);
    add(new BoxGeometry(0.438, 0.004, 0.348), plate, 0, DECK.plateY - 0.002, 0);
    for (const [x, z] of [
      [-0.19, 0.15],
      [0.19, 0.15],
      [-0.19, -0.15],
      [0.19, -0.15],
    ] as const) {
      add(new CylinderGeometry(0.022, 0.026, DECK.footH, 16), black, x, DECK.footH / 2, z);
    }

    // Platter, strobe rim, slip mat, spindle. The platter group spins.
    this.platter.position.set(DECK.platterCentre.x, DECK.plateY, DECK.platterCentre.z);
    this.group.add(this.platter);
    add(
      new CylinderGeometry(DECK.platterR, DECK.platterR, DECK.platterH, 64),
      black,
      0,
      DECK.platterH / 2,
      0,
      this.platter,
    );
    add(
      new CylinderGeometry(DECK.platterR + 0.001, DECK.platterR + 0.001, 0.006, 64, 1, true),
      alu,
      0,
      DECK.platterH - 0.006,
      0,
      this.platter,
    );
    add(
      new CylinderGeometry(DECK.platterR - 0.003, DECK.platterR - 0.003, DECK.matH, 64),
      felt,
      0,
      DECK.platterH + DECK.matH / 2,
      0,
      this.platter,
    );
    add(new CylinderGeometry(0.0035, 0.0035, 0.022, 12), alu, 0, DECK.platterH + 0.011, 0, this.platter);

    // Tonearm: base, pivot yoke, S-shaped tube, headshell, counterweight, rest post.
    add(new CylinderGeometry(0.03, 0.032, 0.012, 24), alu, DECK.pivot.x, DECK.plateY + 0.006, DECK.pivot.z);
    add(
      new CylinderGeometry(0.012, 0.014, DECK.pivotH - 0.01, 16),
      black,
      DECK.pivot.x,
      DECK.plateY + DECK.pivotH / 2,
      DECK.pivot.z,
    );
    this.armYaw.position.set(DECK.pivot.x, DECK.plateY + DECK.pivotH, DECK.pivot.z);
    this.group.add(this.armYaw);
    this.armYaw.add(this.armLift);
    const curve = new CatmullRomCurve3([
      new Vector3(0, 0, -0.02),
      new Vector3(0, 0, 0.08),
      new Vector3(0.006, -0.004, 0.15),
      new Vector3(-0.012, -0.012, 0.2),
      new Vector3(-0.022, -0.018, 0.222),
    ]);
    const tube = add(new TubeGeometry(curve, 40, 0.0042, 8, false), alu, 0, 0, 0, this.armLift);
    const head = add(
      new BoxGeometry(0.02, 0.006, 0.034),
      black,
      DECK.needle.x,
      -0.02,
      DECK.needle.z - 0.006,
      this.armLift,
    );
    head.rotation.y = 18 * DEG;
    const cart = add(
      new BoxGeometry(0.013, 0.012, 0.018),
      brass,
      DECK.needle.x,
      -0.028,
      DECK.needle.z - 0.002,
      this.armLift,
    );
    cart.rotation.y = 18 * DEG;
    const lift = add(
      new BoxGeometry(0.004, 0.004, 0.02),
      alu,
      DECK.needle.x + 0.012,
      -0.02,
      DECK.needle.z - 0.02,
      this.armLift,
    );
    lift.rotation.y = 60 * DEG;
    add(new CylinderGeometry(0.016, 0.016, 0.028, 20), black, 0, 0, -0.05, this.armLift).rotation.x =
      Math.PI / 2;
    this.pickables.push(tube, head, cart);
    const rest = this.needleAt(DECK.restYaw, new Vector3());
    add(
      new CylinderGeometry(0.004, 0.005, 0.03, 10),
      black,
      rest.x + 0.01,
      DECK.plateY + 0.015,
      rest.z - 0.03,
    );

    // Controls: start/stop, 33/45, pitch slider.
    add(new BoxGeometry(0.03, 0.006, 0.03), alu, -0.19, DECK.plateY + 0.003, 0.14);
    add(new BoxGeometry(0.02, 0.005, 0.014), plate, -0.15, DECK.plateY + 0.0025, 0.15);
    add(new BoxGeometry(0.02, 0.005, 0.014), plate, -0.125, DECK.plateY + 0.0025, 0.15);
    add(new BoxGeometry(0.012, 0.002, 0.1), black, 0.19, DECK.plateY + 0.001, 0.07);
    add(new BoxGeometry(0.018, 0.008, 0.012), alu, 0.19, DECK.plateY + 0.004, 0.07);

    // Dust cover, hinged at the back and standing open.
    const hinge = new Object3D();
    hinge.position.set(0, DECK.plateY + 0.004, -0.178);
    hinge.rotation.x = -72 * DEG;
    this.group.add(hinge);
    // Smoked acrylic, as on most decks: a dark tint with a faint reflection of the room.
    const coverMat = new MeshBasicMaterial({
      color: '#0b0a0a',
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: DoubleSide,
    });
    const lid = new Mesh(new BoxGeometry(0.446, 0.004, 0.356), coverMat);
    lid.position.set(0, 0.058, 0.178);
    hinge.add(lid);
    for (const x of [-0.222, 0.222]) {
      const side = new Mesh(new BoxGeometry(0.003, 0.058, 0.356), coverMat);
      side.position.set(x, 0.029, 0.178);
      hinge.add(side);
    }
    const lidEdge = add(new BoxGeometry(0.446, 0.006, 0.004), black, 0, 0.058, 0.356, hinge);
    lidEdge.material = black;

    // Contact shadow on the sideboard.
    const shadowTex = new CanvasTexture(blobTexture(128, 1.4) as HTMLCanvasElement);
    shadowTex.colorSpace = SRGBColorSpace;
    const shadow = new Mesh(
      new PlaneGeometry(0.62, 0.52),
      new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.8 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.group.add(shadow);

    this.leadInYaw = this.solveYaw(DECK.leadInRadius);
    this.runOutYaw = this.solveYaw(DECK.runOutRadius);
    this.setArm(DECK.restYaw, 0);
    this.group.updateMatrixWorld(true);
  }

  private mat(opts: ConstructorParameters<typeof LitMaterial>[0]): LitMaterial {
    const m = new LitMaterial(opts);
    this.materials.push(m);
    return m;
  }

  /** Needle position (deck-local) for an arm yaw in degrees. */
  needleAt(yawDeg: number, out: Vector3): Vector3 {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawDeg * DEG);
    return out
      .copy(DECK.needle)
      .applyQuaternion(q)
      .add(new Vector3(DECK.pivot.x, 0, DECK.pivot.z));
  }

  /** Arm yaw (degrees) that puts the needle `radius` from the spindle. Bisection; the arm swings inward. */
  solveYaw(radius: number): number {
    const dist = (yaw: number) => {
      const p = this.needleAt(yaw, this.tmp);
      return Math.hypot(p.x - DECK.platterCentre.x, p.z - DECK.platterCentre.z);
    };
    let lo = -70;
    let hi = DECK.restYaw;
    // dist decreases as the arm swings in (negative yaw).
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (dist(mid) > radius) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  setArm(yawDeg: number, lift: number): void {
    this.armYaw.rotation.y = yawDeg * DEG;
    this.armLift.rotation.x = -lift * DECK.liftDeg * DEG;
  }

  setPlatterAngle(rad: number): void {
    this.platter.rotation.y = rad;
  }

  /** World pose for a disc lying on the mat, rotated by `angle`. */
  discPose(angle: number, out: { position: Vector3; quaternion: Quaternion }, drop = 0): void {
    out.position
      .set(DECK.platterCentre.x, this.discY + drop, DECK.platterCentre.z)
      .applyMatrix4(this.group.matrixWorld);
    out.quaternion
      .copy(this.group.quaternion)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle));
  }

  dispose(): void {
    this.materials.forEach((m) => {
      m.uniforms.uMap?.value?.dispose?.();
      m.dispose();
    });
    this.group.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
  }
}
