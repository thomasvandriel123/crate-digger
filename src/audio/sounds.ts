/**
 * Sound, off by default, behind one speaker toggle. Web Audio with short samples prepared after the
 * first user gesture (autoplay policy): a soft card-flick per focus step (pitch varied 6%, volume by
 * scroll speed, rate-limited to 12/s), paper slide on pull/return, a thump at needle drop, and a very
 * quiet low-passed crackle loop (about -30 dB) while playing.
 *
 * Samples are synthesised here, so there is nothing to license (see CREDITS.md). To use recorded
 * samples instead, drop CC0 or self-recorded OGG files in public/sounds/ (flick.ogg, slide.ogg,
 * thump.ogg, crackle.ogg, each under 60 KB); they take precedence when present.
 */

import { mulberry32 } from '../data/random';

type SampleName = 'flick' | 'slide' | 'thump' | 'crackle';

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SampleName, AudioBuffer>();
  private crackle: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private flickTimes: number[] = [];
  private wantCrackle = false;
  private rand = mulberry32(12345);
  enabled = false;

  constructor(private baseUrl: string) {}

  /** Call from a user gesture. Creates the context and prepares samples once. */
  async unlock(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    for (const name of ['flick', 'slide', 'thump', 'crackle'] as SampleName[]) {
      this.buffers.set(name, (await this.loadOverride(name)) ?? this.synthesise(name));
    }
    if (this.wantCrackle) this.startCrackle();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) void this.unlock();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
    if (on && this.wantCrackle) this.startCrackle();
    if (!on) this.stopCrackleNow();
  }

  private async loadOverride(name: SampleName): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(new URL(`sounds/${name}.ogg`, this.baseUrl));
      if (!res.ok || !res.headers.get('content-type')?.includes('audio')) return null;
      return await this.ctx!.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private play(name: SampleName, { gain = 1, rate = 1 } = {}): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
  }

  /** One card flick per focus step; `speed` in records per second. */
  flick(speed: number): void {
    const now = performance.now();
    this.flickTimes = this.flickTimes.filter((t) => now - t < 1000);
    if (this.flickTimes.length >= 12) return;
    this.flickTimes.push(now);
    const gain = 0.25 + Math.min(1, Math.abs(speed) / 12) * 0.55;
    this.play('flick', { gain, rate: 1 + (this.rand() - 0.5) * 0.12 });
  }

  slide(): void {
    this.play('slide', { gain: 0.55, rate: 0.95 + this.rand() * 0.1 });
  }

  thump(): void {
    this.play('thump', { gain: 0.8 });
  }

  startCrackle(): void {
    this.wantCrackle = true;
    if (!this.enabled || !this.ctx || !this.master || this.crackle) return;
    const buffer = this.buffers.get('crackle');
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    // About -30 dB, faded in so it never clicks.
    gain.gain.setTargetAtTime(0.032, this.ctx.currentTime, 0.4);
    source.connect(gain).connect(this.master);
    source.start();
    this.crackle = { source, gain };
  }

  stopCrackle(): void {
    this.wantCrackle = false;
    this.stopCrackleNow();
  }

  private stopCrackleNow(): void {
    const c = this.crackle;
    if (!c || !this.ctx) return;
    this.crackle = null;
    c.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    c.source.stop(this.ctx.currentTime + 0.8);
  }

  // --- synthesis ---------------------------------------------------------------------------------------

  private synthesise(name: SampleName): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const rand = mulberry32(name.length * 7919);
    const noise = () => rand() * 2 - 1;
    const make = (seconds: number, fill: (t: number, i: number) => number): AudioBuffer => {
      const n = Math.floor(seconds * sr);
      const buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = fill(i / sr, i);
      return buf;
    };
    // One-pole filters for shaping noise.
    const lowpass = (cutoff: number) => {
      const a = Math.exp((-2 * Math.PI * cutoff) / sr);
      let y = 0;
      return (x: number) => (y = (1 - a) * x + a * y);
    };
    const highpass = (cutoff: number) => {
      const lp = lowpass(cutoff);
      return (x: number) => x - lp(x);
    };

    switch (name) {
      case 'flick': {
        // Card edge brushing card: a bright noise tick plus a tiny woody tock.
        const hp = highpass(1800);
        const lp = lowpass(6500);
        return make(0.06, (t) => {
          const env = Math.exp(-t / 0.008);
          const tock = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.012) * 0.35;
          return (lp(hp(noise())) * env * 0.9 + tock) * 0.8;
        });
      }
      case 'slide': {
        // Paper sleeve sliding: filtered noise with a slow swell and a sweep in brightness.
        const lpA = lowpass(2200);
        const lpB = lowpass(4200);
        const hp = highpass(500);
        return make(0.42, (t) => {
          const env = Math.min(1, t / 0.07) * Math.exp(-Math.max(0, t - 0.12) / 0.12);
          const mix = t / 0.42;
          const n = noise();
          return hp(lpA(n) * (1 - mix) + lpB(n) * mix) * env * 0.7;
        });
      }
      case 'thump': {
        // Needle drop: a soft low thud with a falling pitch, then a brief crackle.
        let phase = 0;
        const lp = lowpass(900);
        return make(0.5, (t) => {
          const f = 48 + 42 * Math.exp(-t / 0.03);
          phase += (2 * Math.PI * f) / sr;
          const thud = Math.sin(phase) * Math.exp(-t / 0.07);
          const click = lp(noise()) * Math.exp(-t / 0.006) * 0.5;
          const crackle = t > 0.08 && rand() < 0.004 ? noise() * 0.5 : 0;
          return (thud * 0.9 + click) * 0.8 + crackle * Math.exp(-(t - 0.08) / 0.2);
        });
      }
      case 'crackle': {
        // Four seconds of sparse pops over faint hiss, low-passed; random, so the loop seam is invisible.
        const lp = lowpass(4200);
        let pop = 0;
        return make(4, () => {
          if (rand() < 26 / sr) pop = (rand() * 0.8 + 0.2) * (rand() < 0.5 ? -1 : 1);
          else pop *= 0.82;
          return lp(pop + noise() * 0.035);
        });
      }
    }
  }

  dispose(): void {
    this.stopCrackleNow();
    void this.ctx?.close();
    this.ctx = null;
  }
}
