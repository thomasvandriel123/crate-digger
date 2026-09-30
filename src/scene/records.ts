/**
 * Records in the crates.
 *
 * Every album has one persistent RecordEntity for the lifetime of the page (never destroyed and recreated
 * on filter changes). Each frame, entities in visible crates get a target pose from the fan; near the
 * focus they are full meshes with cover textures, further away they are one instanced draw of thin edges
 * tinted with each album's dominant colour.
 *
 * Re-shelving (filter/sort changes) is animated FLIP-style: a record's previous on-screen transform becomes
 * an offset that a spring decays to zero, so it glides from where it was to where it now belongs, and a new
 * change mid-flight retargets from the current state. Records leaving the view sink and fade where they
 * stood; records arriving rise into their slots. Only the active crate and its neighbours animate this way.
 */

import type { Vector2 } from 'three';
import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Raycaster,
  type Scene,
  type Texture,
  Vector3,
  type Camera,
} from 'three';
import { hashString, mulberry32 } from '../data/random';
import type { Album, Crate, Layout } from '../data/types';
import { RESHELVE, planReshelve } from '../motion/choreography';
import { EASE } from '../motion/easing';
import { SPRINGS, Spring } from '../motion/spring';
import { Tween } from '../motion/tween';
import type { CrateRow } from './crate';
import { layoutCrate, recordPose } from './fan';
import { EdgeMaterial, RecordMaterial } from './materials';
import type { CoverTextureCache } from './textureCache';
import { tuning } from './tuning';

export const LP_SIZE = 0.315;
export const LP_THICKNESS = 0.004;
const DEG = Math.PI / 180;

const sleeveGeometry = (() => {
  const g = new BoxGeometry(LP_SIZE, LP_SIZE, LP_THICKNESS);
  g.translate(0, LP_SIZE / 2, 0);
  return g;
})();

export type PoseOverride = (out: { position: Vector3; quaternion: Quaternion }) => void;

export class RecordEntity {
  crate = -1;
  index = -1;
  readonly flip = new Spring(0, SPRINGS.shelve);
  flipDelay = 0;
  readonly flipOffset = new Vector3();
  readonly flipQuat = new Quaternion();
  pendingFlip = false;
  readonly presence = new Tween(1);
  readonly hover = new Spring(0, SPRINGS.hover);
  readonly rim = new Tween(0);
  readonly coverFade = new Tween(0);
  mesh: RecordMesh | null = null;
  rendered = false;
  renderedFrame = -1;
  readonly renderedPos = new Vector3();
  readonly renderedQuat = new Quaternion();
  /** Outgoing: frozen where it stood while it sinks out. */
  ghost = false;
  /** Detached from its crate (held, on the deck, on the easel): pose supplied by a controller. */
  override: PoseOverride | null = null;
  /** Generated back-of-sleeve texture while the record is held. */
  backTexture: Texture | null = null;
  readonly dominant: Color;
  readonly wear: Vector3;
  readonly wearAmount: number;

  constructor(readonly album: Album) {
    this.dominant = new Color(album.palette.dominant);
    const rand = mulberry32(hashString(album.id));
    // Some records look slightly loved, none look dirty: wear is seeded per album, at most 8% opacity.
    this.wearAmount = rand() < 0.6 ? 0.35 + rand() * 0.65 : 0;
    this.wear = new Vector3(0.5 + (rand() - 0.5) * 0.08, 0.5 + (rand() - 0.5) * 0.08, 0.4 + rand() * 0.06);
  }

  get inCrate(): boolean {
    return this.crate >= 0 && !this.override;
  }
}

export class RecordMesh {
  readonly mesh: Mesh;
  readonly material: RecordMaterial;
  entity: RecordEntity | null = null;
  usedFrame = -1;

  constructor() {
    this.material = new RecordMaterial(LP_SIZE);
    this.mesh = new Mesh(sleeveGeometry, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
  }
}

interface CrateArrays {
  z: Float32Array;
  y: Float32Array;
  lean: Float32Array;
}

export interface DividerInstance {
  crate: number;
  label: string;
  position: Vector3;
  quaternion: Quaternion;
  dim: number;
  fade: number;
  /** Left or right tab position, alternating by label, so neighbouring tabs don't hide each other. */
  tab: number;
}

export interface RecordSystemOptions {
  capacity: number;
}

export class RecordSystem {
  readonly entities = new Map<string, RecordEntity>();
  readonly edges: InstancedMesh;
  private edgeColor: InstancedBufferAttribute;
  private edgeDim: InstancedBufferAttribute;
  private meshPool: RecordMesh[] = [];
  private activeMeshes = new Set<RecordMesh>();
  private animating = new Set<RecordEntity>();
  private ghosts = new Set<RecordEntity>();
  private arrays: CrateArrays;
  private frame = 0;
  private layout: Layout | null = null;
  private raycaster = new Raycaster();
  private tmpM = new Matrix4();
  private tmpM2 = new Matrix4();
  private tmpQ = new Quaternion();
  private tmpQ2 = new Quaternion();
  private tmpV = new Vector3();
  private crateQ = new Quaternion();
  private crateP = new Vector3();
  private crateS = new Vector3();
  private one = new Vector3(1, 1, 1);
  private identity = new Quaternion();
  private xAxis = new Vector3(1, 0, 0);
  private pose = { position: new Vector3(), quaternion: new Quaternion() };
  /** Divider poses for this frame (consumed by the divider system). */
  readonly dividers: DividerInstance[] = [];
  private dividerPool: DividerInstance[] = [];
  reducedMotion = false;
  /** Scroll velocity of the active crate (records/s), for prefetching ahead. */
  velocity = 0;
  keyboardFocus: string | null = null;

  constructor(
    private scene: Scene,
    private crates: CrateRow,
    private covers: CoverTextureCache,
    private focusOf: (crate: number) => number,
    opts: RecordSystemOptions,
  ) {
    this.arrays = {
      z: new Float32Array(opts.capacity),
      y: new Float32Array(opts.capacity),
      lean: new Float32Array(opts.capacity),
    };
    const maxEdges = opts.capacity * 6;
    this.edges = new InstancedMesh(sleeveGeometry, new EdgeMaterial(LP_SIZE), maxEdges);
    this.edges.instanceMatrix.setUsage(DynamicDrawUsage);
    this.edgeColor = new InstancedBufferAttribute(new Float32Array(maxEdges * 3), 3).setUsage(
      DynamicDrawUsage,
    );
    this.edgeDim = new InstancedBufferAttribute(new Float32Array(maxEdges), 1).setUsage(DynamicDrawUsage);
    this.edges.geometry = sleeveGeometry.clone();
    this.edges.geometry.setAttribute('aColor', this.edgeColor);
    this.edges.geometry.setAttribute('aDim', this.edgeDim);
    this.edges.frustumCulled = false;
    this.edges.count = 0;
    scene.add(this.edges);
  }

  setAlbums(albums: readonly Album[]): void {
    for (const album of albums) {
      if (!this.entities.has(album.id)) this.entities.set(album.id, new RecordEntity(album));
    }
  }

  get(albumId: string): RecordEntity | undefined {
    return this.entities.get(albumId);
  }

  get moving(): boolean {
    return this.animating.size > 0 || this.ghosts.size > 0;
  }

  // --- layout reconciliation ---------------------------------------------------------------------------

  /**
   * Apply a new layout. `prev`/`next` give the active crate and its focus before and after the change;
   * `animate` false snaps everything (reduced motion uses a full-frame cross-fade instead, see post.ts).
   */
  setLayout(
    layout: Layout,
    prev: { active: number; focus: number },
    next: { active: number; focus: number },
    animate: boolean,
  ): void {
    const prevActive = prev.active;
    const nextActive = next.active;
    const prevVisible: RecordEntity[] = [];
    for (const e of this.entities.values()) {
      e.pendingFlip = false;
      if (e.rendered && e.crate >= 0 && Math.abs(e.crate - prevActive) <= 1 && !e.override)
        prevVisible.push(e);
    }
    const prevFocus = prev.focus;
    const prevDistance = new Map(
      prevVisible.map((e) => [e, Math.abs(e.crate - prevActive) * 100 + Math.abs(e.index - prevFocus)]),
    );

    for (const e of this.entities.values()) {
      const slot = layout.slots.get(e.album.id);
      e.crate = slot ? slot.crate : -1;
      e.index = slot ? slot.index : -1;
    }
    this.layout = layout;

    const isNextVisible = (e: RecordEntity) => e.crate >= 0 && Math.abs(e.crate - nextActive) <= 1;
    const prevSet = new Set(prevVisible);
    const outgoing = prevVisible.filter((e) => !isNextVisible(e));
    const incoming: RecordEntity[] = [];
    for (const e of this.entities.values()) {
      if (e.override) continue;
      if (isNextVisible(e) && !prevSet.has(e)) incoming.push(e);
    }

    if (!animate || this.reducedMotion) {
      for (const e of this.entities.values()) {
        e.flip.snap(0);
        e.flipDelay = 0;
        e.presence.snap(1);
        this.clearGhost(e);
      }
      return;
    }

    // Stagger outward from the focus, so the ripple starts where the eye is.
    outgoing.sort((a, b) => prevDistance.get(a)! - prevDistance.get(b)!);
    const nextFocus = next.focus;
    const nextDistance = (e: RecordEntity) =>
      Math.abs(e.crate - nextActive) * 100 + Math.abs(e.index - nextFocus);
    incoming.sort((a, b) => nextDistance(a) - nextDistance(b));
    const plan = planReshelve(
      outgoing.map((e) => e.album.id),
      incoming.map((e) => e.album.id),
    );

    for (const e of prevVisible) {
      if (!isNextVisible(e)) continue;
      // Staying: remember where it was drawn; the offset is resolved against its new pose next frame.
      e.pendingFlip = true;
      e.flipDelay = plan.moveDelayMs / 1000;
      this.clearGhost(e);
      if (e.presence.value < 1 && !e.presence.active) e.presence.start(1, RESHELVE.inDurationMs, EASE.out);
      this.animating.add(e);
    }
    for (const e of outgoing) {
      e.ghost = true;
      this.ghosts.add(e);
      e.presence.start(0, RESHELVE.outDurationMs, EASE.in, { delayMs: plan.outgoing.get(e.album.id) ?? 0 });
      this.animating.add(e);
    }
    for (const e of incoming) {
      this.clearGhost(e);
      e.flip.snap(0);
      e.presence.start(1, RESHELVE.inDurationMs, EASE.outQuart, {
        from: 0,
        delayMs: plan.incoming.get(e.album.id) ?? RESHELVE.inStartMs,
      });
      this.animating.add(e);
    }
    // Everything else updates instantly and invisibly.
    for (const e of this.entities.values()) {
      if (!prevSet.has(e) && !incoming.includes(e) && !e.override) {
        e.flip.snap(0);
        if (!e.ghost) e.presence.snap(1);
      }
    }
  }

  private clearGhost(e: RecordEntity): void {
    if (e.ghost) {
      e.ghost = false;
      this.ghosts.delete(e);
    }
  }

  // --- simulation --------------------------------------------------------------------------------------

  /** Fixed-step springs (FLIP glides, hover). */
  fixedUpdate(dt: number): void {
    for (const e of this.animating) {
      if (e.flipDelay > 0) {
        e.flipDelay -= dt;
      } else if (e.flip.value !== 0 || e.flip.velocity !== 0) {
        e.flip.step(dt);
        e.flip.settle(1e-4);
      }
      if (e.hover.value !== e.hover.target || e.hover.velocity !== 0) {
        e.hover.step(dt);
        e.hover.settle(1e-3);
      }
    }
  }

  /** Frame-rate tweens and bookkeeping. Returns true while anything is animating. */
  update(dt: number): boolean {
    for (const e of this.animating) {
      e.presence.update(dt);
      e.rim.update(dt);
      e.coverFade.update(dt);
      const idle =
        e.flip.value === 0 &&
        e.flip.velocity === 0 &&
        !e.pendingFlip &&
        !e.presence.active &&
        !e.rim.active &&
        !e.coverFade.active &&
        e.hover.value === e.hover.target &&
        e.hover.velocity === 0 &&
        e.flipDelay <= 0;
      if (e.ghost && !e.presence.active && e.presence.value <= 0) this.clearGhost(e);
      if (idle && !e.ghost) this.animating.delete(e);
    }
    return this.animating.size > 0;
  }

  setHover(albumId: string | null): void {
    for (const e of this.animating) if (e.album.id !== albumId) e.hover.target = 0;
    if (albumId) {
      const e = this.entities.get(albumId);
      if (e) {
        e.hover.target = this.reducedMotion ? 0 : 1;
        this.animating.add(e);
      }
    }
  }

  setRim(albumId: string | null): void {
    if (this.keyboardFocus === albumId) return;
    const prev = this.keyboardFocus ? this.entities.get(this.keyboardFocus) : null;
    if (prev) {
      prev.rim.start(0, 200);
      this.animating.add(prev);
    }
    this.keyboardFocus = albumId;
    const next = albumId ? this.entities.get(albumId) : null;
    if (next) {
      next.rim.start(1, 200);
      this.animating.add(next);
    }
  }

  wake(e: RecordEntity): void {
    this.animating.add(e);
  }

  // --- per-frame placement -----------------------------------------------------------------------------

  /** Compute every visible record's pose and assign full meshes, edge instances and textures. */
  place(): void {
    this.frame++;
    let edgeCount = 0;
    const layout = this.layout;
    this.releaseDividers();
    const f = tuning.fan;
    const a = this.crates.a;

    if (layout) {
      for (const k of this.crates.visibleCrates()) {
        const crate = layout.crates[k];
        if (!crate) continue;
        this.crates.matrixFor(k, this.tmpM);
        this.tmpM.decompose(this.crateP, this.crateQ, this.crateS);
        const rel = Math.abs(k - a);
        const strength = f.neighbourFan + (1 - f.neighbourFan) * this.crates.activeness(k);
        const focus = this.focusOf(k);
        const n = crate.records.length;
        layoutCrate(n, focus, f, strength, this.arrays);
        const dim = this.crates.dimFor(k);
        const cratePresence = this.crates.presenceFor(k);
        const fullRadius = rel < 0.5 ? f.fullRadius : rel < 1.4 ? f.neighbourFullRadius : -1;
        const texRadius = rel < 0.5 ? f.textureRadius : rel < 1.4 ? f.neighbourTextureRadius : -1;
        const isActive = k === this.crates.activeIndex;

        for (let i = 0; i < n; i++) {
          const e = this.entities.get(crate.records[i]!);
          if (!e || e.override) continue;
          const s = i - focus;
          this.naturalPose(e, i, s);
          this.applyFlip(e);
          e.renderedPos.copy(this.pose.position);
          e.renderedQuat.copy(this.pose.quaternion);
          e.rendered = true;
          e.renderedFrame = this.frame;
          const presence = Math.min(e.presence.value, cratePresence);
          const abs = Math.abs(s);
          if (texRadius >= 0) {
            const ahead = isActive ? s - this.velocity * 0.35 : s;
            if (abs <= texRadius || Math.abs(ahead) <= texRadius)
              this.covers.want(e.album, Math.abs(ahead) + rel * 30);
          }
          if (abs <= fullRadius) {
            const coverMix = 1 - smoothstepR(fullRadius - 2.5, fullRadius, abs);
            this.drawFull(e, dim, presence, coverMix);
          } else if (edgeCount < this.edges.instanceMatrix.count) {
            this.drawEdge(e, edgeCount++, dim, presence);
          }
        }

        for (const d of crate.dividers)
          this.placeDivider(crate, d.at, d.label, k, focus, strength, dim, cratePresence);
      }
    }

    for (const e of this.ghosts) {
      if (e.override) continue;
      this.pose.position.copy(e.renderedPos);
      this.pose.quaternion.copy(e.renderedQuat);
      this.pose.position.y -= RESHELVE.sinkMeters * (1 - e.presence.value);
      if (e.mesh || edgeCount >= this.edges.instanceMatrix.count)
        this.drawFull(e, this.crates.dimFor(e.crate), e.presence.value, 1);
      else this.drawEdge(e, edgeCount++, 0, e.presence.value);
    }

    for (const e of this.entities.values()) {
      if (!e.override) continue;
      e.override(this.pose);
      e.renderedPos.copy(this.pose.position);
      e.renderedQuat.copy(this.pose.quaternion);
      e.rendered = true;
      e.renderedFrame = this.frame;
      this.covers.want(e.album, -10);
      this.drawFull(e, 0, 1, 1);
    }

    for (const m of this.activeMeshes) {
      if (m.usedFrame !== this.frame) this.releaseMesh(m);
    }
    for (const e of this.entities.values()) {
      if (e.renderedFrame !== this.frame) e.rendered = false;
    }

    this.edges.count = edgeCount;
    this.edges.instanceMatrix.needsUpdate = true;
    this.edgeColor.needsUpdate = true;
    this.edgeDim.needsUpdate = true;
  }

  /** The pose a record would have standing in its crate slot right now (no FLIP, no override). */
  naturalPose(e: RecordEntity, i: number, s: number): { position: Vector3; quaternion: Quaternion } {
    const f = tuning.fan;
    const c = tuning.crate;
    const hover = e.hover.value;
    const presence = e.presence.value;
    const y = c.riserY + this.arrays.y[i]! + f.hoverLift * hover - RESHELVE.sinkMeters * (1 - presence);
    const z = this.crates.dims.frontZ - this.arrays.z[i]!;
    const lean = this.arrays.lean[i]! - f.hoverTilt * hover * (s >= -0.5 ? 1 : 0);
    this.tmpV.set(0, y, z).applyQuaternion(this.crateQ).add(this.crateP);
    this.tmpQ.setFromAxisAngle(this.xAxis, -lean * DEG);
    this.pose.position.copy(this.tmpV);
    this.pose.quaternion.copy(this.crateQ).multiply(this.tmpQ);
    return this.pose;
  }

  /** Slot pose for any in-crate record (used by the hold controller for its arcs). */
  slotPose(e: RecordEntity, out: { position: Vector3; quaternion: Quaternion }): boolean {
    const layout = this.layout;
    if (!layout || e.crate < 0) return false;
    const crate = layout.crates[e.crate];
    if (!crate) return false;
    this.crates.matrixFor(e.crate, this.tmpM);
    this.tmpM.decompose(this.crateP, this.crateQ, this.crateS);
    const f = tuning.fan;
    const strength = f.neighbourFan + (1 - f.neighbourFan) * this.crates.activeness(e.crate);
    const focus = this.focusOf(e.crate);
    layoutCrate(crate.records.length, focus, f, strength, this.arrays);
    this.naturalPose(e, e.index, e.index - focus);
    out.position.copy(this.pose.position);
    out.quaternion.copy(this.pose.quaternion);
    return true;
  }

  private applyFlip(e: RecordEntity): void {
    if (e.pendingFlip) {
      e.pendingFlip = false;
      e.flipOffset.copy(e.renderedPos).sub(this.pose.position);
      this.tmpQ2.copy(this.pose.quaternion).invert();
      e.flipQuat.copy(e.renderedQuat).multiply(this.tmpQ2);
      if (e.flipOffset.lengthSq() > 1e-8 || Math.abs(e.flipQuat.w) < 0.99999) {
        e.flip.snap(1);
        e.flip.target = 0;
        e.flip.setParams(SPRINGS.shelve);
        this.animating.add(e);
      } else {
        e.flip.snap(0);
      }
    }
    const w = e.flip.value;
    if (w !== 0) {
      this.pose.position.addScaledVector(e.flipOffset, w);
      this.tmpQ2.copy(this.identity).slerp(e.flipQuat, Math.max(-0.5, Math.min(1.5, w)));
      this.pose.quaternion.premultiply(this.tmpQ2);
    }
  }

  private drawFull(e: RecordEntity, dim: number, opacity: number, coverMix: number): void {
    let m = e.mesh;
    if (!m) {
      m = this.meshPool.pop() ?? new RecordMesh();
      m.entity = e;
      e.mesh = m;
      this.activeMeshes.add(m);
      this.scene.add(m.mesh);
      const u = m.material.uniforms;
      u.uDominant.value.copy(e.dominant);
      u.uWear.value.copy(e.wear);
      u.uWearAmount.value = e.wearAmount;
      u.uCover.value = null;
      u.uCoverMix.value = 0;
      this.setBackOnMesh(m, e.backTexture);
      const tex = this.covers.peek(e.album.id);
      if (tex) {
        u.uCover.value = tex;
        e.coverFade.snap(1);
      } else {
        e.coverFade.snap(0);
      }
    }
    m.usedFrame = this.frame;
    const u = m.material.uniforms;
    if (!u.uCover.value) {
      const tex = this.covers.peek(e.album.id);
      if (tex) {
        u.uCover.value = tex;
        e.coverFade.start(1, 250, EASE.out, { from: 0 });
        this.animating.add(e);
      }
    }
    u.uCoverMix.value = (u.uCover.value ? e.coverFade.value : 0) * coverMix;
    u.uDim.value = dim;
    u.uOpacity.value = opacity;
    u.uRim.value = e.rim.value;
    m.mesh.matrix.compose(this.pose.position, this.pose.quaternion, this.one);
    m.mesh.matrixWorld.copy(m.mesh.matrix);
    m.mesh.visible = opacity > 0.01;
  }

  private drawEdge(e: RecordEntity, idx: number, dim: number, opacity: number): void {
    if (e.mesh) this.releaseMesh(e.mesh);
    this.tmpM2.compose(this.pose.position, this.pose.quaternion, this.one);
    this.edges.setMatrixAt(idx, this.tmpM2);
    this.edgeColor.setXYZ(idx, e.dominant.r, e.dominant.g, e.dominant.b);
    this.edgeDim.setX(idx, opacity < 0.999 ? -(1 - opacity) : dim);
  }

  private releaseMesh(m: RecordMesh): void {
    if (m.entity) m.entity.mesh = null;
    m.entity = null;
    m.material.uniforms.uCover.value = null;
    this.setBackOnMesh(m, null);
    this.activeMeshes.delete(m);
    this.scene.remove(m.mesh);
    this.meshPool.push(m);
  }

  private setBackOnMesh(m: RecordMesh, tex: Texture | null): void {
    m.material.uniforms.uBack.value = tex;
    m.material.uniforms.uHasBack.value = tex ? 1 : 0;
  }

  setBackTexture(e: RecordEntity, tex: Texture | null): void {
    e.backTexture = tex;
    if (e.mesh) this.setBackOnMesh(e.mesh, tex);
  }

  // --- dividers -----------------------------------------------------------------------------------------

  private releaseDividers(): void {
    this.dividerPool.push(...this.dividers);
    this.dividers.length = 0;
  }

  private placeDivider(
    crate: Crate,
    at: number,
    label: string,
    k: number,
    focus: number,
    strength: number,
    dim: number,
    presence: number,
  ): void {
    const f = tuning.fan;
    const c = tuning.crate;
    const s = at - 0.5 - focus;
    const z0 = at > 0 ? this.arrays.z[at - 1]! : -0.008;
    const z1 = at < crate.records.length ? this.arrays.z[at]! : z0 + f.restSpacing;
    // A divider behaves like the record in front of its slot: in front of the focus it sinks with the
    // flipped stack, behind it rides the raked fan. It never lifts with the focus.
    const pose = recordPose(s - 0.5, f, s > 0 ? strength : 1);
    const d = this.dividerPool.pop() ?? {
      crate: 0,
      label: '',
      position: new Vector3(),
      quaternion: new Quaternion(),
      dim: 0,
      fade: 1,
      tab: 0,
    };
    // In front of the focus a divider sinks with the flipped stack, so its tab stays 3 cm above it; the
    // floor board hides the last couple of centimetres, as it does for the records.
    const y = Math.max(-0.02, c.riserY + (s > 0 ? pose.y : Math.min(0, pose.y)));
    this.tmpV
      .set(0, y, this.crates.dims.frontZ - (z0 + z1) / 2)
      .applyQuaternion(this.crateQ)
      .add(this.crateP);
    // Sunk dividers lean only slightly forward, so the flag rests on the stack instead of the front wall.
    this.tmpQ.setFromAxisAngle(this.xAxis, -(s > 0 ? pose.lean : Math.max(pose.lean, -6)) * DEG);
    d.crate = k;
    d.label = label;
    d.position.copy(this.tmpV);
    d.quaternion.copy(this.crateQ).multiply(this.tmpQ);
    d.dim = dim;
    d.fade = presence;
    d.tab = hashString(label) % 2;
    this.dividers.push(d);
  }

  // --- picking ------------------------------------------------------------------------------------------

  /** Album under the pointer (full meshes only: those are the clickable ones). */
  pick(ndc: Vector2, camera: Camera): RecordEntity | null {
    this.raycaster.setFromCamera(ndc, camera);
    const meshes = [...this.activeMeshes].filter((m) => m.mesh.visible).map((m) => m.mesh);
    // Raycaster uses matrixWorld; we keep it in sync in drawFull.
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      const m = [...this.activeMeshes].find((x) => x.mesh === hit.object);
      if (m?.entity) return m.entity;
    }
    return null;
  }

  get stats() {
    return { full: this.activeMeshes.size, edges: this.edges.count, animating: this.animating.size };
  }

  /** After WebGL context loss: drop cover references so they reload and fade back in. */
  resetCovers(): void {
    for (const m of this.activeMeshes) {
      m.material.uniforms.uCover.value = null;
      m.entity?.coverFade.snap(0);
    }
  }

  dispose(): void {
    for (const m of [...this.activeMeshes, ...this.meshPool]) m.material.dispose();
    this.edges.geometry.dispose();
    (this.edges.material as EdgeMaterial).dispose();
    this.scene.remove(this.edges);
  }
}

function smoothstepR(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
