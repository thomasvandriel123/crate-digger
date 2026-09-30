/**
 * Composition root for the 3D view. Owns the one requestAnimationFrame loop: input is read once per
 * frame, springs integrate at a fixed 1/240 s, tweens advance by the (clamped) frame delta, and the frame
 * renders only when something moves; otherwise a 15 fps idle tick keeps dust, grain and camera drift alive.
 *
 * The scene subscribes to the derived layout and reports focus/hold/deck state back through the stores.
 */

import {
  CanvasTexture,
  Color,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { SoundBoard } from '../audio/sounds';
import { colourInfo, COLOUR_BINS } from '../data/colour';
import { resolveFocus } from '../data/layout';
import type { Album, Crate, Layout, Track } from '../data/types';
import { FocusController } from '../motion/focus';
import { FixedStepper } from '../motion/spring';
import { Tween } from '../motion/tween';
import { EASE } from '../motion/easing';
import type { PlaybackAdapter } from '../playback/adapter';
import { registerCommands } from '../state/commands';
import {
  $deck,
  $focus,
  $held,
  $hover,
  $layout,
  $library,
  $playback,
  $reducedMotion,
  $sort,
  $stats,
  $statsVisible,
} from '../state/store';
import { CameraRig } from './camera';
import { CrateRow } from './crate';
import { Deck } from './deck';
import { DividerSystem } from './dividers';
import { Dust } from './dust';
import { HoldController } from './hold';
import { Input } from './input';
import { lightUniforms, setLights } from './materials';
import { PostPipeline } from './post';
import { LP_SIZE, type RecordEntity, RecordSystem } from './records';
import { buildRoom, ROOM, type Room } from './room';
import { AdaptiveResolution, FrameTimes } from './stats';
import { CoverTextureCache } from './textureCache';
import { ctx2d, makeCanvas } from './textures';
import { tuning } from './tuning';
import { Turntable } from './turntable';

const WHEEL_GAIN = 0.05; // records/s per wheel pixel
const DRAG_PX_PER_RECORD = { mouse: 34, touch: 26 };
const IDLE_FPS = 15;

export interface SceneAppOptions {
  canvas: HTMLCanvasElement;
  /** Absolute URL of the data folder (library.json, covers/). */
  dataUrl: string;
  mobile: boolean;
  capacity: number;
  sounds: SoundBoard;
  adapter: PlaybackAdapter;
  loadTracks: (album: Album) => Promise<Track[] | null>;
  /** Debug: render straight to the canvas, skipping post-processing (?nopost). */
  debugNoPost?: boolean;
}

export function supportsWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

const EMPTY_CRATE: Crate = { key: '__empty__', index: 0, records: [], dividers: [], label: 'Empty' };

export class SceneApp {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly rig = new CameraRig();
  private room: Room;
  private crates: CrateRow;
  private covers: CoverTextureCache;
  private records: RecordSystem;
  private dividers: DividerSystem;
  private hold: HoldController;
  private turntable: Turntable;
  private deck: Deck;
  private dust: Dust;
  private post: PostPipeline;
  private input: Input;
  private stepper = new FixedStepper();
  private frameTimes = new FrameTimes(240);
  private adaptive: AdaptiveResolution;
  private focusControllers = new Map<number, FocusController>();
  private layout: Layout | null = null;
  private crateOffsets: number[] = [];
  private raf = 0;
  private lastFrame = 0;
  private lastFull = false;
  private wantFrame = true;
  private contextLost = false;
  private lastFocusKey = '';
  private lastFocusIndex = -1;
  private focusVia: 'pointer' | 'keyboard' | 'init' = 'init';
  private wheelAccY = 0;
  private wheelAccX = 0;
  private crateCooldown = 0;
  private hovered: RecordEntity | null = null;
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private heldCentre = new Vector3();
  private reduced = false;
  private emptyCard: Mesh;
  private emptyFade = new Tween(0);
  private cardLocal = new Matrix4();
  private unsubs: (() => void)[] = [];
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private maxPixelRatio: number;
  private statsTimer = 0;
  private firstFrameDone: (() => void) | null = null;
  readonly firstFrame: Promise<void>;

  constructor(private opts: SceneAppOptions) {
    const { canvas } = opts;
    this.firstFrame = new Promise((resolve) => (this.firstFrameDone = resolve));
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(new Color('#140e0b'));
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, opts.mobile ? 1.5 : 2);
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.scene.background = new Color('#140e0b');

    this.room = buildRoom();
    this.scene.add(this.room.group);
    setLights({ ...tuning.lights, keyPos: ROOM.key });

    this.crates = new CrateRow(opts.capacity);
    this.scene.add(this.crates.group);
    this.covers = new CoverTextureCache(this.renderer, opts.dataUrl, {
      capacity: opts.mobile ? 60 : 120,
      variant: opts.mobile ? 'thumb' : 'web',
      anisotropy: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
    });
    this.records = new RecordSystem(this.scene, this.crates, this.covers, (k) => this.focusValue(k), {
      capacity: opts.capacity,
    });
    this.dividers = new DividerSystem(this.scene);
    this.dividers.tintFor = (label) => {
      if ($sort.get().mode !== 'colour') return null;
      const bin = COLOUR_BINS.find((b) => b.name === label);
      return bin ? colourInfo(bin.id).swatch : null;
    };

    this.hold = new HoldController(this.records, this.rig, opts.loadTracks);
    this.hold.onPhase = (phase, album, flipped) => {
      if (phase === 'idle' || !album) $held.set(null);
      else $held.set({ albumId: album.id, phase, flipped });
      if (phase === 'pulling' || phase === 'returning') opts.sounds.slide();
    };

    this.turntable = new Turntable(ROOM.turntable);
    this.scene.add(this.turntable.group);
    this.deck = new Deck(this.scene, this.turntable, this.records, this.hold, opts.adapter, {
      onPhase: (phase, album) => $deck.set({ phase, albumId: album?.id ?? null }),
      onNeedleDrop: () => {
        opts.sounds.thump();
        opts.sounds.startCrackle();
      },
      onNeedleLift: () => opts.sounds.stopCrackle(),
      onPaperSlide: () => opts.sounds.slide(),
    });
    this.unsubs.push(opts.adapter.subscribe((s) => $playback.set(s)));

    this.dust = new Dust(this.room.lampPosition);
    this.scene.add(this.dust.points);
    this.emptyCard = this.buildEmptyCard();
    this.scene.add(this.emptyCard);

    this.post = new PostPipeline(this.renderer, this.scene, this.rig.camera, {
      multisampling: opts.mobile ? 0 : 4,
      smaa: opts.mobile,
    });
    this.adaptive = new AdaptiveResolution(this.maxPixelRatio, 1, (r) => this.setPixelRatio(r));

    this.input = new Input(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();

    this.unsubs.push(
      $reducedMotion.subscribe((on) => this.setReducedMotion(on)),
      $layout.subscribe((layout) => {
        if (layout) this.applyLayout(layout);
      }),
      $statsVisible.subscribe(() => (this.wantFrame = true)),
    );
    this.registerCommands();
    document.fonts?.ready.then(() => {
      this.dividers.refreshFonts();
      this.wantFrame = true;
    });
  }

  start(): void {
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  // --- layout ------------------------------------------------------------------------------------------

  /** Focus a specific album after the next layout (initial URL focus, back/forward). */
  private pendingFocus: string | null = null;

  focusAlbumAfterLayout(albumId: string | null): void {
    this.pendingFocus = albumId;
    if (albumId && this.layout?.slots.has(albumId)) this.focusAlbum(albumId, true);
  }

  private applyLayout(layout: Layout): void {
    if (layout === this.layout) return;
    const first = this.layout === null;
    const prevLayout = this.layout;
    const prevActive = this.crates.activeIndex;
    const prevFocusValue = this.focusValue(prevActive);
    const currentFocus = $focus.get().albumId;

    let focusId = this.pendingFocus && layout.slots.has(this.pendingFocus) ? this.pendingFocus : null;
    this.pendingFocus = null;
    focusId ??= resolveFocus(currentFocus, prevLayout?.order ?? [], layout);
    const slot = focusId ? layout.slots.get(focusId) : undefined;
    const nextActive = slot?.crate ?? 0;
    const nextIndex = slot?.index ?? 0;

    // A held record that no longer matches goes back (it sinks away with the rest).
    if (this.hold.entity && !layout.slots.has(this.hold.entity.album.id)) this.hold.release();

    // Persistent record entities for every album (created once; reused across every re-shelve).
    const library = $library.get();
    if (library) this.records.setAlbums(library.albums);
    this.layout = layout;
    this.crateOffsets = [];
    let acc = 0;
    for (const c of layout.crates) {
      this.crateOffsets.push(acc);
      acc += c.records.length;
    }
    this.focusControllers.clear();
    const fc = this.focusController(nextActive);
    fc.goTo(nextIndex, true);

    const crates = layout.crates.length > 0 ? layout.crates : [EMPTY_CRATE];
    this.crates.setLayout(crates, nextActive, !first);
    this.records.setLayout(
      layout,
      { active: prevActive, focus: prevFocusValue },
      { active: nextActive, focus: nextIndex },
      !this.reduced || first,
    );
    if (this.reduced && !first) this.post.crossFadeNext();

    const empty = layout.crates.length === 0;
    this.emptyFade.start(empty ? 1 : 0, empty ? 500 : 200, EASE.inOut, { delayMs: empty ? 350 : 0 });
    this.lastFocusKey = '';
    this.wantFrame = true;
  }

  private focusController(k: number): FocusController {
    let fc = this.focusControllers.get(k);
    if (!fc) {
      const count = this.layout?.crates[k]?.records.length ?? 0;
      fc = new FocusController(count, 0);
      this.focusControllers.set(k, fc);
    }
    return fc;
  }

  private focusValue(k: number): number {
    return this.focusControllers.get(k)?.value ?? 0;
  }

  private get activeFocus(): FocusController {
    return this.focusController(this.crates.activeIndex);
  }

  // --- commands ----------------------------------------------------------------------------------------

  private registerCommands(): void {
    registerCommands({
      step: (delta) => {
        this.focusVia = 'keyboard';
        if (this.hold.active) this.hold.release();
        this.activeFocus.step(delta, this.reduced);
        if (this.reduced) this.post.crossFadeNext();
        this.wantFrame = true;
      },
      edge: (which) => {
        this.focusVia = 'keyboard';
        if (this.hold.active) this.hold.release();
        const n = this.layout?.crates[this.crates.activeIndex]?.records.length ?? 0;
        this.activeFocus.goTo(which === 'start' ? 0 : n - 1, this.reduced);
        if (this.reduced) this.post.crossFadeNext();
        this.wantFrame = true;
      },
      switchCrate: (delta) => {
        this.focusVia = 'keyboard';
        this.switchCrate(delta);
      },
      focusAlbum: (id) => {
        this.focusVia = 'keyboard';
        this.focusAlbum(id, false);
      },
      toggleHold: () => {
        this.focusVia = 'keyboard';
        if (this.hold.active) this.hold.release();
        else this.pullFocused();
        this.wantFrame = true;
      },
      release: () => {
        this.hold.release();
        this.wantFrame = true;
      },
      flip: () => {
        this.hold.toggleFlip();
        this.wantFrame = true;
      },
      playOrPause: () => {
        if (this.hold.active && this.hold.phase !== 'returning') this.deck.playHeld();
        else this.deck.togglePause();
        this.wantFrame = true;
      },
      stopAndPutAway: () => {
        this.deck.stopAndPutAway();
        this.wantFrame = true;
      },
    });
  }

  private switchCrate(delta: number): void {
    if (!this.layout || this.layout.crates.length === 0) return;
    if (this.hold.active) this.hold.release();
    const target = this.crates.activeIndex + delta;
    if (this.crates.switchTo(target)) {
      this.rig.nudge(Math.sign(delta));
      if (this.reduced) this.post.crossFadeNext();
    }
    this.wantFrame = true;
  }

  private focusAlbum(id: string, instant: boolean): void {
    const slot = this.layout?.slots.get(id);
    if (!slot) return;
    if (this.hold.active && this.hold.entity?.album.id !== id) this.hold.release();
    if (slot.crate !== this.crates.activeIndex) {
      this.crates.switchTo(slot.crate);
      if (instant) this.crates.active.snap(slot.crate);
    }
    this.focusController(slot.crate).goTo(slot.index, instant || this.reduced);
    if (this.reduced) this.post.crossFadeNext();
    this.wantFrame = true;
  }

  private pullFocused(): void {
    const crate = this.layout?.crates[this.crates.activeIndex];
    if (!crate || crate.records.length === 0) return;
    const fc = this.activeFocus;
    const id = crate.records[fc.target];
    const e = id ? this.records.get(id) : undefined;
    if (!e || e.override) return;
    fc.goTo(fc.target);
    this.hold.pull(e);
  }

  // --- frame loop --------------------------------------------------------------------------------------

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.contextLost) return;
    const busy = this.wantFrame || this.isMoving() || this.input.pending;
    const sinceLast = now - this.lastFrame;
    if (!busy && sinceLast < 1000 / IDLE_FPS - 2) return;
    const dt = Math.min(sinceLast / 1000, 0.05);
    this.lastFrame = now;
    this.wantFrame = false;

    this.processInput(dt);
    this.stepper.advance(dt, (h) => {
      for (const fc of this.focusControllers.values()) fc.update(h);
      this.records.fixedUpdate(h);
      this.rig.fixedUpdate(h);
      this.hold.fixedUpdate(h);
    });
    this.crates.update(dt);
    this.records.update(dt);
    this.hold.update(dt);
    this.deck.update(dt);
    this.rig.update(dt);
    this.dust.update(dt);
    this.emptyFade.update(dt);
    this.updateEmptyCard();
    this.trackFocus();

    this.records.velocity = this.activeFocus.velocity;
    this.records.place();
    this.dividers.update(this.records.dividers);
    const pendingCovers = this.covers.endFrame();
    if (pendingCovers) this.wantFrame = true;

    const heldE = this.hold.entity;
    if (heldE)
      this.heldCentre
        .set(0, LP_SIZE / 2, 0)
        .applyQuaternion(heldE.renderedQuat)
        .add(heldE.renderedPos);
    this.post.setHold(this.hold.dim.value, this.heldCentre);
    lightUniforms.uSheen.value = this.rig.sheenPhase;
    const postBusy = this.post.update(dt);
    if (postBusy) this.wantFrame = true;

    this.renderer.info.reset();
    if (this.opts.debugNoPost) this.renderer.render(this.scene, this.rig.camera);
    else this.post.render(dt);
    const full = busy;
    if (full && this.lastFull) {
      this.frameTimes.push(sinceLast);
      this.adaptive.sample(sinceLast, now);
    } else {
      this.adaptive.pause();
    }
    this.lastFull = full;
    this.publishStats(now);
    if (this.firstFrameDone) {
      this.firstFrameDone();
      this.firstFrameDone = null;
    }
  };

  private isMoving(): boolean {
    return (
      this.crates.moving ||
      this.records.moving ||
      this.hold.moving ||
      this.deck.moving ||
      this.rig.moving ||
      this.emptyFade.active ||
      [...this.focusControllers.values()].some((fc) => fc.moving)
    );
  }

  private processInput(dt: number): void {
    const inp = this.input.consume();
    if (inp.pointer && inp.pointerType === 'mouse') {
      this.rig.setPointer(inp.pointer.x, inp.pointer.y);
      this.hold.setPointer(inp.pointer.x, inp.pointer.y);
    } else if (!inp.pointer) {
      this.rig.setPointer(0, 0);
      this.hold.setPointer(0, 0);
    }
    const fc = this.activeFocus;
    this.crateCooldown = Math.max(0, this.crateCooldown - dt);

    if (inp.wheelY !== 0 && !this.hold.active) {
      this.focusVia = 'pointer';
      if (this.reduced) {
        this.wheelAccY += inp.wheelY;
        while (Math.abs(this.wheelAccY) >= 80) {
          const s = Math.sign(this.wheelAccY);
          fc.step(s, true);
          this.post.crossFadeNext();
          this.wheelAccY -= s * 80;
        }
      } else {
        fc.impulse(inp.wheelY * WHEEL_GAIN);
      }
    } else if (inp.wheelY !== 0 && this.hold.active) {
      // Scrolling while holding puts the record back and keeps digging.
      if (Math.abs(inp.wheelY) > 30) this.hold.release();
    }
    if (inp.wheelX !== 0) {
      this.wheelAccX += inp.wheelX;
      if (Math.abs(this.wheelAccX) > 140 && this.crateCooldown === 0) {
        this.switchCrate(Math.sign(this.wheelAccX));
        this.crateCooldown = 0.5;
        this.wheelAccX = 0;
      }
    } else {
      this.wheelAccX *= 0.8;
    }

    if (!this.hold.active) {
      const pxPerRecord = inp.pointerType === 'mouse' ? DRAG_PX_PER_RECORD.mouse : DRAG_PX_PER_RECORD.touch;
      if (inp.dragStarted) {
        this.focusVia = 'pointer';
        if (!this.reduced) fc.dragStart();
      }
      if (inp.dragY !== 0) {
        if (this.reduced) {
          this.wheelAccY += inp.dragY * (80 / pxPerRecord);
          while (Math.abs(this.wheelAccY) >= 80) {
            const s = Math.sign(this.wheelAccY);
            fc.step(s, true);
            this.post.crossFadeNext();
            this.wheelAccY -= s * 80;
          }
        } else {
          fc.dragBy(inp.dragY / pxPerRecord, dt);
        }
      }
      if (inp.dragEnded) fc.dragEnd();
    }
    if (inp.swipe !== 0) this.switchCrate(inp.swipe);

    for (const click of inp.clicks) this.handleClick(click);

    if (inp.pointerMoved || this.isMoving()) this.updateHover(inp.pointer, inp.pointerType);
  }

  private handleClick(p: { x: number; y: number }): void {
    this.focusVia = 'pointer';
    this.ndc.set(p.x, p.y);
    const hit = this.records.pick(this.ndc, this.rig.camera);
    if (this.hold.active) {
      if (hit && hit === this.hold.entity) this.hold.toggleFlip();
      else this.hold.release();
      return;
    }
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    const armHit = this.raycaster.intersectObjects(this.turntable.pickables, false)[0];
    if (armHit && (!hit || armHit.distance < this.rig.camera.position.distanceTo(hit.renderedPos))) {
      this.deck.togglePause();
      return;
    }
    if (!hit || hit.override) return;
    const active = this.crates.activeIndex;
    if (hit.crate === active) {
      const fc = this.focusController(active);
      if (hit.index === fc.target && Math.abs(fc.value - fc.target) < 0.35) this.hold.pull(hit);
      else fc.goTo(hit.index);
    } else if (Math.abs(hit.crate - active) === 1) {
      this.crates.switchTo(hit.crate);
      this.rig.nudge(Math.sign(hit.crate - active));
      this.focusController(hit.crate).goTo(hit.index);
    }
    this.wantFrame = true;
  }

  private updateHover(pointer: { x: number; y: number } | null, type: string): void {
    let next: RecordEntity | null = null;
    if (pointer && type === 'mouse' && !this.input.isDragging) {
      this.ndc.set(pointer.x, pointer.y);
      next = this.records.pick(this.ndc, this.rig.camera);
    }
    const canvas = this.opts.canvas;
    const heldHit = this.hold.active && next === this.hold.entity;
    const cursor = this.input.isDragging
      ? 'grabbing'
      : next
        ? 'pointer'
        : this.hold.active
          ? 'default'
          : this.overCrate(pointer)
            ? 'grab'
            : 'default';
    if (canvas.style.cursor !== cursor) canvas.style.cursor = heldHit ? 'pointer' : cursor;
    const hoverable = next && !next.override && !this.hold.active ? next : null;
    if (hoverable !== this.hovered) {
      this.hovered = hoverable;
      this.records.setHover(hoverable?.album.id ?? null);
      $hover.set(hoverable?.album.id ?? null);
    }
  }

  private overCrate(pointer: { x: number; y: number } | null): boolean {
    if (!pointer) return false;
    this.ndc.set(pointer.x, pointer.y);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    return this.raycaster.intersectObject(this.crates.group, true).length > 0;
  }

  private trackFocus(): void {
    const layout = this.layout;
    const k = this.crates.activeIndex;
    const crate = layout?.crates[k];
    const fc = this.activeFocus;
    const idx = crate ? fc.index : -1;
    const id = crate?.records[idx] ?? null;
    const key = `${k}:${id}`;
    if (key === this.lastFocusKey) return;
    const sameCrate = this.lastFocusKey.startsWith(`${k}:`);
    if (sameCrate && idx !== this.lastFocusIndex) this.opts.sounds.flick(fc.velocity);
    this.lastFocusKey = key;
    this.lastFocusIndex = idx;
    $focus.set({
      albumId: id,
      crate: k,
      crateCount: layout?.crates.length ?? 0,
      position: (this.crateOffsets[k] ?? 0) + Math.max(0, idx),
      via: this.focusVia,
    });
    this.records.setRim(this.focusVia === 'keyboard' ? id : null);
  }

  // --- empty state -------------------------------------------------------------------------------------

  private buildEmptyCard(): Mesh {
    const canvas = makeCanvas(512, 320);
    const draw = () => {
      const ctx = ctx2d(canvas);
      ctx.fillStyle = '#efe6d2';
      ctx.fillRect(0, 0, 512, 320);
      ctx.strokeStyle = 'rgba(90, 60, 40, 0.25)';
      ctx.lineWidth = 2;
      for (let y = 80; y < 320; y += 44) {
        ctx.beginPath();
        ctx.moveTo(24, y);
        ctx.lineTo(488, y);
        ctx.stroke();
      }
      ctx.fillStyle = '#2b1f1a';
      ctx.textAlign = 'center';
      ctx.font = '600 64px "Caveat", cursive';
      ctx.fillText('Nothing here.', 256, 140);
      ctx.font = '500 46px "Caveat", cursive';
      ctx.fillText('Try fewer filters', 256, 214);
    };
    draw();
    const tex = new CanvasTexture(canvas as HTMLCanvasElement);
    tex.colorSpace = SRGBColorSpace;
    document.fonts?.ready.then(() => {
      draw();
      tex.needsUpdate = true;
    });
    const mesh = new Mesh(
      new PlaneGeometry(0.3, 0.1875),
      new MeshBasicMaterial({ map: tex, transparent: true, color: new Color(0.55, 0.45, 0.36) }),
    );
    mesh.visible = false;
    return mesh;
  }

  private updateEmptyCard(): void {
    const v = this.emptyFade.value;
    this.emptyCard.visible = v > 0.01;
    if (!this.emptyCard.visible) return;
    this.emptyCard.matrixAutoUpdate = false;
    this.crates.matrixFor(0, this.emptyCard.matrix, 1, 1);
    // Leaning in the empty bin, rising into place as it fades in.
    this.cardLocal
      .makeRotationX(-0.35)
      .setPosition(0, tuning.crate.frontWallHeight + 0.02 - (1 - v) * 0.08, 0.05);
    this.emptyCard.matrix.multiply(this.cardLocal);
    this.emptyCard.matrixWorld.copy(this.emptyCard.matrix);
    (this.emptyCard.material as MeshBasicMaterial).opacity = v;
  }

  // --- resize, quality, lifecycle ----------------------------------------------------------------------

  private resize(): void {
    const el = this.opts.canvas.parentElement ?? this.opts.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.width = w;
    this.height = h;
    this.rig.resize(w, h);
    this.post.setSize(w, h);
    this.dust.setViewportHeight(h * this.renderer.getPixelRatio());
    this.wantFrame = true;
  }

  private setPixelRatio(ratio: number): void {
    this.renderer.setPixelRatio(ratio);
    this.post.setSize(this.width, this.height);
    this.dust.setViewportHeight(this.height * ratio);
    this.wantFrame = true;
  }

  private setReducedMotion(on: boolean): void {
    this.reduced = on;
    this.rig.reducedMotion = on;
    this.hold.reducedMotion = on;
    this.deck.reducedMotion = on;
    this.crates.reducedMotion = on;
    this.records.reducedMotion = on;
    this.post.reducedMotion = on;
    this.dust.visible = !on;
    if (on) this.rig.setPointer(0, 0);
    this.wantFrame = true;
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.covers.reset();
    this.records.resetCovers();
    this.dividers.refreshFonts();
    this.resize();
    this.wantFrame = true;
  };

  private publishStats(now: number): void {
    if (now - this.statsTimer < 500) return;
    this.statsTimer = now;
    const info = this.renderer.info;
    const r = this.records.stats;
    $stats.set({
      fps: this.frameTimes.count ? 1000 / Math.max(1, this.frameTimes.mean(60)) : 0,
      frameMs: this.frameTimes.mean(60),
      p95: this.frameTimes.percentile(0.95, 120),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      textureMB: this.covers.bytes / (1024 * 1024),
      covers: this.covers.size,
      pixelRatio: this.renderer.getPixelRatio(),
      full: r.full,
      edges: r.edges,
    });
  }

  /** Redraw canvas-generated text once web fonts have arrived. */
  refreshFonts(): void {
    this.dividers.refreshFonts();
    this.crates.refreshLabels();
    this.wantFrame = true;
  }

  /** Re-read tuning values (dev panel). */
  applyTuning(): void {
    this.rig.resize(this.width, this.height);
    this.post.applyTuning();
    this.wantFrame = true;
  }

  /** Debug/test hook: frame-time samples and renderer counters. */
  debugSnapshot() {
    return {
      p95: this.frameTimes.percentile(0.95),
      mean: this.frameTimes.mean(),
      samples: this.frameTimes.count,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      textures: this.renderer.info.memory.textures,
      coverMB: this.covers.bytes / (1024 * 1024),
      pixelRatio: this.renderer.getPixelRatio(),
      focus: this.activeFocus.value,
      activeCrate: this.crates.activeIndex,
      hold: this.hold.phase,
      deck: this.deck.phase,
      moving: this.isMoving(),
    };
  }

  /** Test hook: add scroll velocity as if the wheel moved. */
  debugImpulse(recordsPerSecond: number): void {
    this.activeFocus.impulse(recordsPerSecond);
    this.wantFrame = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    this.resizeObserver.disconnect();
    this.input.dispose();
    this.opts.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.opts.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.deck.dispose();
    this.records.dispose();
    this.dividers.dispose();
    this.crates.dispose();
    this.turntable.dispose();
    this.dust.dispose();
    this.room.dispose();
    this.covers.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}
