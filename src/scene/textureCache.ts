/**
 * Cover textures with windowed residency.
 *
 * - LRU of at most 120 textures on desktop, 60 on mobile, at 512 px (256 px on mobile).
 * - Decoding happens off the main thread (`createImageBitmap`); GPU uploads are capped at 2 per frame,
 *   highest priority first, so scrolling never hitches on a burst of uploads.
 * - Callers mark what they want each frame with a priority (distance from the focus, biased in the
 *   direction of scroll); anything not wanted can be evicted, and evicted textures are disposed.
 * - After WebGL context loss the cache is dropped and refilled from the HTTP cache.
 */

import { LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Texture, type WebGLRenderer } from 'three';
import type { Album } from '../data/types';

interface Entry {
  album: Album;
  texture: Texture | null;
  bitmap: ImageBitmap | null;
  state: 'queued' | 'loading' | 'decoded' | 'ready' | 'failed';
  lastWanted: number;
  priority: number;
  bytes: number;
  controller: AbortController | null;
}

export interface CoverCacheOptions {
  capacity: number;
  variant: 'web' | 'thumb';
  uploadsPerFrame: number;
  concurrency: number;
  anisotropy: number;
}

export class CoverTextureCache {
  private entries = new Map<string, Entry>();
  private frame = 0;
  private inFlight = 0;
  private opts: CoverCacheOptions;
  bytes = 0;
  uploadsThisFrame = 0;

  constructor(
    private renderer: WebGLRenderer,
    private baseUrl: string,
    opts: Partial<CoverCacheOptions> = {},
  ) {
    this.opts = { capacity: 120, variant: 'web', uploadsPerFrame: 2, concurrency: 6, anisotropy: 8, ...opts };
  }

  get size(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.texture) n++;
    return n;
  }

  /**
   * Mark an album as wanted this frame. Lower priority numbers load first. Returns the texture once it
   * has been uploaded to the GPU, else null (show the dominant-colour tile meanwhile).
   */
  want(album: Album, priority: number): Texture | null {
    let e = this.entries.get(album.id);
    if (!e) {
      e = {
        album,
        texture: null,
        bitmap: null,
        state: 'queued',
        lastWanted: this.frame,
        priority,
        bytes: 0,
        controller: null,
      };
      this.entries.set(album.id, e);
    }
    e.lastWanted = this.frame;
    e.priority = Math.min(e.priority, priority);
    return e.state === 'ready' ? e.texture : null;
  }

  peek(albumId: string): Texture | null {
    const e = this.entries.get(albumId);
    return e?.state === 'ready' ? e.texture : null;
  }

  /** Call once per frame after all `want` calls: starts fetches, uploads, evicts. */
  endFrame(): boolean {
    const wanted = [...this.entries.values()].filter((e) => e.lastWanted === this.frame);
    wanted.sort((a, b) => a.priority - b.priority);

    // Start fetches in priority order.
    for (const e of wanted) {
      if (this.inFlight >= this.opts.concurrency) break;
      if (e.state === 'queued') this.load(e);
    }

    // Upload decoded bitmaps, capped per frame.
    this.uploadsThisFrame = 0;
    for (const e of wanted) {
      if (this.uploadsThisFrame >= this.opts.uploadsPerFrame) break;
      if (e.state === 'decoded' && e.bitmap) {
        this.upload(e);
        this.uploadsThisFrame++;
      }
    }

    this.evict();
    // Reset priorities for the next frame.
    for (const e of wanted) e.priority = Infinity;
    this.frame++;
    return this.inFlight > 0 || wanted.some((e) => e.state === 'decoded');
  }

  private url(album: Album): string {
    const path = this.opts.variant === 'thumb' ? album.cover.thumb : album.cover.web;
    return new URL(path, this.baseUrl).toString();
  }

  private load(e: Entry): void {
    e.state = 'loading';
    this.inFlight++;
    const controller = new AbortController();
    e.controller = controller;
    fetch(this.url(e.album), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
      .then((bitmap) => {
        if (e.state !== 'loading') {
          bitmap.close();
          return;
        }
        e.bitmap = bitmap;
        e.state = 'decoded';
      })
      .catch(() => {
        if (e.state === 'loading') e.state = 'failed';
      })
      .finally(() => {
        this.inFlight--;
        e.controller = null;
      });
  }

  private upload(e: Entry): void {
    const bitmap = e.bitmap!;
    const tex = new Texture(bitmap as unknown as HTMLImageElement);
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = false;
    const pot = isPowerOfTwo(bitmap.width) && isPowerOfTwo(bitmap.height);
    tex.generateMipmaps = pot;
    tex.minFilter = pot ? LinearMipmapLinearFilter : LinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = this.opts.anisotropy;
    tex.needsUpdate = true;
    this.renderer.initTexture(tex);
    // Measure before closing: a closed ImageBitmap reports 0 x 0.
    e.bytes = bitmap.width * bitmap.height * 4 * (pot ? 4 / 3 : 1);
    this.bytes += e.bytes;
    // The GPU has the pixels now; free the decoded copy. Context loss rebuilds from the HTTP cache.
    bitmap.close();
    e.bitmap = null;
    e.texture = tex;
    e.state = 'ready';
  }

  private evict(): void {
    const resident = [...this.entries.values()].filter((e) => e.state === 'ready' || e.state === 'decoded');
    const excess = resident.length - this.opts.capacity;
    if (excess > 0) {
      resident
        .filter((e) => e.lastWanted !== this.frame)
        .sort((a, b) => a.lastWanted - b.lastWanted)
        .slice(0, excess)
        .forEach((e) => this.drop(e));
    }
    // Forget stale queued/failed entries so the map does not grow without bound.
    for (const e of this.entries.values()) {
      if (this.frame - e.lastWanted > 600 && (e.state === 'queued' || e.state === 'failed'))
        this.entries.delete(e.album.id);
      if (e.state === 'loading' && this.frame - e.lastWanted > 120) {
        e.controller?.abort();
        e.state = 'queued';
      }
    }
  }

  private drop(e: Entry): void {
    e.controller?.abort();
    e.bitmap?.close();
    if (e.texture) {
      e.texture.dispose();
      this.bytes -= e.bytes;
    }
    this.entries.delete(e.album.id);
  }

  /** WebGL context lost: GPU copies are gone and bitmaps were closed, so start over. */
  reset(): void {
    for (const e of [...this.entries.values()]) this.drop(e);
    this.bytes = 0;
  }

  dispose(): void {
    this.reset();
  }
}

function isPowerOfTwo(n: number): boolean {
  return (n & (n - 1)) === 0 && n > 0;
}
