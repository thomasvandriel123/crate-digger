/**
 * Pointer, wheel and touch input, accumulated by event handlers and consumed once per frame. Handlers never
 * touch the scene; they only record what happened. Gestures: vertical drag or swipe moves the focus (with
 * a fling), horizontal swipe switches crate, a short press without travel is a click.
 */

export interface InputFrame {
  /** Pointer in normalised device coordinates, or null when outside the canvas. */
  pointer: { x: number; y: number } | null;
  pointerMoved: boolean;
  pointerType: string;
  /** Wheel delta in pixels (lines and pages normalised), vertical and horizontal. */
  wheelY: number;
  wheelX: number;
  /** Vertical drag since last frame, in pixels (positive = finger moved up). */
  dragY: number;
  dragging: boolean;
  dragEnded: boolean;
  dragStarted: boolean;
  /** Horizontal swipe completed this frame: -1 (to the left) or 1. */
  swipe: number;
  clicks: { x: number; y: number }[];
}

const TAP_SLOP = 6;
const SWIPE_MIN = 48;

export class Input {
  private frame: InputFrame = Input.empty();
  private pointer: { x: number; y: number } | null = null;
  private down: {
    id: number;
    x: number;
    y: number;
    lastY: number;
    axis: 'none' | 'v' | 'h';
    type: string;
  } | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private el: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on('pointermove', (e) => this.onMove(e));
    on('pointerdown', (e) => this.onDown(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', () => this.onCancel());
    on('pointerleave', (e) => {
      if (!this.down && e.pointerType === 'mouse') {
        this.pointer = null;
        this.frame.pointer = null;
        this.frame.pointerMoved = true;
      }
    });
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
  }

  static empty(): InputFrame {
    return {
      pointer: null,
      pointerMoved: false,
      pointerType: 'mouse',
      wheelY: 0,
      wheelX: 0,
      dragY: 0,
      dragging: false,
      dragEnded: false,
      dragStarted: false,
      swipe: 0,
      clicks: [],
    };
  }

  private ndc(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
  }

  private onMove(e: PointerEvent): void {
    this.pointer = this.ndc(e);
    this.frame.pointer = this.pointer;
    this.frame.pointerMoved = true;
    this.frame.pointerType = e.pointerType;
    const d = this.down;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.axis === 'none' && Math.hypot(dx, dy) > TAP_SLOP) {
      d.axis = Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h';
      if (d.axis === 'v') {
        this.frame.dragStarted = true;
        d.lastY = e.clientY;
      }
    }
    if (d.axis === 'v') {
      this.frame.dragY += d.lastY - e.clientY;
      this.frame.dragging = true;
      d.lastY = e.clientY;
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.el.setPointerCapture?.(e.pointerId);
    this.down = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastY: e.clientY,
      axis: 'none',
      type: e.pointerType,
    };
    this.pointer = this.ndc(e);
    this.frame.pointer = this.pointer;
    this.frame.pointerMoved = true;
    this.frame.pointerType = e.pointerType;
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    if (!d || d.id !== e.pointerId) return;
    this.down = null;
    const dx = e.clientX - d.x;
    if (d.axis === 'none') this.frame.clicks.push(this.ndc(e));
    else if (d.axis === 'v') this.frame.dragEnded = true;
    else if (d.axis === 'h' && Math.abs(dx) > SWIPE_MIN) this.frame.swipe = dx < 0 ? 1 : -1;
    if (e.pointerType !== 'mouse') {
      this.pointer = null;
      this.frame.pointer = null;
    }
  }

  private onCancel(): void {
    if (this.down?.axis === 'v') this.frame.dragEnded = true;
    this.down = null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.el.clientHeight : 1;
    // Pinch-zoom gestures arrive as ctrl+wheel on trackpads; ignore them rather than scrolling.
    if (e.ctrlKey) return;
    this.frame.wheelY += e.deltaY * scale;
    this.frame.wheelX += e.deltaX * scale;
    this.pointer = this.ndc(e);
    this.frame.pointer = this.pointer;
  }

  get pending(): boolean {
    const f = this.frame;
    return (
      f.pointerMoved ||
      f.wheelY !== 0 ||
      f.wheelX !== 0 ||
      f.dragging ||
      f.dragEnded ||
      f.clicks.length > 0 ||
      f.swipe !== 0 ||
      !!this.down
    );
  }

  get isDragging(): boolean {
    return this.down?.axis === 'v';
  }

  /** Take everything that happened since the last frame. */
  consume(): InputFrame {
    const f = this.frame;
    this.frame = Input.empty();
    this.frame.pointer = this.pointer;
    this.frame.pointerType = f.pointerType;
    f.dragging = f.dragging || this.isDragging;
    return f;
  }

  dispose(): void {
    this.cleanup.forEach((c) => c());
  }
}
