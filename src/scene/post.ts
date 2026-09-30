/**
 * Post-processing, merged into few passes (pmndrs/postprocessing):
 *   render -> [hold focus: dim 25% + blur behind a held record] -> bloom on the lamp -> 10% vignette
 *   -> 2% film grain -> tone mapping -> warm grade (shadows toward warm, never pure black)
 *   -> SMAA on mobile (MSAA on desktop) -> reduced-motion cross-fade.
 */

import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  KawaseBlurPass,
  KernelSize,
  NoiseEffect,
  Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import {
  type Camera,
  HalfFloatType,
  type Scene,
  ShaderMaterial,
  Uniform,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
  type Texture,
} from 'three';
import { tuning } from './tuning';

class HoldFocusEffect extends Effect {
  constructor(blur: Texture) {
    super(
      'HoldFocusEffect',
      /* glsl */ `
        uniform sampler2D blurBuffer;
        uniform float amount;
        uniform float focusDepth;
        uniform float dim;
        void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
          float behind = smoothstep(focusDepth + 0.002, focusDepth + 0.008, depth);
          float k = amount * behind;
          vec3 blurred = texture2D(blurBuffer, uv).rgb;
          vec3 c = mix(inputColor.rgb, blurred, k);
          outputColor = vec4(c * (1.0 - dim * k), inputColor.a);
        }
      `,
      {
        attributes: EffectAttribute.DEPTH,
        uniforms: new Map<string, Uniform>([
          ['blurBuffer', new Uniform(blur)],
          ['amount', new Uniform(0)],
          ['focusDepth', new Uniform(0.5)],
          ['dim', new Uniform(tuning.hold.dim)],
        ]),
      },
    );
  }
}

class GradeEffect extends Effect {
  constructor() {
    super(
      'GradeEffect',
      /* glsl */ `
        uniform float warmth;
        uniform vec3 floorColor;
        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          vec3 c = inputColor.rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float shadow = 1.0 - smoothstep(0.0, 0.4, l);
          // Warm the shadows (a touch of amber), keep highlights neutral.
          c = mix(c, c * vec3(1.06, 0.97, 0.86), warmth * 6.0 * shadow);
          // Shadows are never pure black: lift toward #140e0b.
          c = c + floorColor * (1.0 - smoothstep(0.0, 0.25, l));
          outputColor = vec4(c, inputColor.a);
        }
      `,
      {
        uniforms: new Map<string, Uniform>([
          ['warmth', new Uniform(tuning.post.warmth)],
          ['floorColor', new Uniform(new Vector3(0.0065, 0.0045, 0.0035))],
        ]),
      },
    );
  }
}

/** Renders a blurred copy of the scene into its own target for HoldFocusEffect. No buffer swap. */
class BlurCapturePass extends Pass {
  readonly target: WebGLRenderTarget;
  private blur: KawaseBlurPass;

  constructor() {
    super('BlurCapturePass');
    this.needsSwap = false;
    this.blur = new KawaseBlurPass({ kernelSize: KernelSize.MEDIUM, resolutionScale: 0.5 });
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    this.blur.render(renderer, inputBuffer, this.target);
  }

  override setSize(width: number, height: number): void {
    this.blur.setSize(width, height);
    this.target.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }

  override dispose(): void {
    this.blur.dispose();
    this.target.dispose();
    super.dispose();
  }
}

/**
 * Reduced motion: discrete changes cross-fade over 120 ms instead of moving. Keeps a copy of the last
 * frame; `trigger()` freezes it and fades it out over the new frame. When it is the final pass it also
 * does the output encoding (linear to sRGB) that the last EffectPass would otherwise do.
 */
class CrossFadePass extends Pass {
  private prev: WebGLRenderTarget;
  private material: ShaderMaterial;
  fade = 0;
  private frozen = false;
  private hasPrev = false;

  constructor() {
    super('CrossFadePass');
    this.prev = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    this.material = new ShaderMaterial({
      uniforms: {
        inputBuffer: { value: null },
        prevBuffer: { value: null },
        fade: { value: 0 },
        encode: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D inputBuffer;
        uniform sampler2D prevBuffer;
        uniform float fade;
        uniform float encode;
        varying vec2 vUv;
        vec3 toSRGB(vec3 c) {
          c = clamp(c, 0.0, 1.0);
          return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
        }
        void main() {
          vec4 c = texture2D(inputBuffer, vUv);
          if (fade > 0.0) c = mix(c, texture2D(prevBuffer, vUv), fade);
          gl_FragColor = vec4(encode > 0.5 ? toSRGB(c.rgb) : c.rgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    this.fullscreenMaterial = this.material;
  }

  trigger(): void {
    if (!this.hasPrev) return;
    this.frozen = true;
    this.fade = 1;
  }

  update(dt: number): boolean {
    if (this.fade <= 0) return false;
    this.fade = Math.max(0, this.fade - dt / 0.12);
    if (this.fade === 0) this.frozen = false;
    return true;
  }

  override render(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    outputBuffer: WebGLRenderTarget | null,
  ): void {
    const u = this.material.uniforms;
    u.inputBuffer!.value = inputBuffer.texture;
    u.prevBuffer!.value = this.prev.texture;
    u.fade!.value = this.fade;
    u.encode!.value = this.renderToScreen ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
    if (!this.frozen) {
      u.fade!.value = 0;
      u.encode!.value = 0;
      renderer.setRenderTarget(this.prev);
      renderer.render(this.scene, this.camera);
      this.hasPrev = true;
    }
  }

  override setSize(width: number, height: number): void {
    this.prev.setSize(width, height);
    this.hasPrev = false;
  }

  override dispose(): void {
    this.prev.dispose();
    this.material.dispose();
    super.dispose();
  }
}

export interface PostOptions {
  multisampling: number;
  smaa: boolean;
}

export class PostPipeline {
  readonly composer: EffectComposer;
  private blurCapture: BlurCapturePass;
  private hold: HoldFocusEffect;
  private bloom: BloomEffect;
  private vignette: VignetteEffect;
  private noise: NoiseEffect;
  private grade: GradeEffect;
  private toneMapping: ToneMappingEffect;
  private crossFade: CrossFadePass;
  private mainPass: EffectPass;
  private smaaPass: EffectPass | null = null;
  private tmp = new Vector3();

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    private camera: Camera,
    opts: PostOptions,
  ) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType,
      multisampling: opts.multisampling,
    });
    this.composer.addPass(new RenderPass(scene, camera));
    this.blurCapture = new BlurCapturePass();
    this.blurCapture.enabled = false;
    this.composer.addPass(this.blurCapture);

    this.hold = new HoldFocusEffect(this.blurCapture.target.texture);
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: tuning.post.bloomThreshold,
      luminanceSmoothing: tuning.post.bloomSmoothing,
      intensity: tuning.post.bloomIntensity,
      radius: 0.7,
    });
    this.vignette = new VignetteEffect({ darkness: tuning.post.vignette * 4.5, offset: 0.32 });
    this.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    this.noise.blendMode.opacity.value = tuning.post.grain * 3;
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.grade = new GradeEffect();
    this.mainPass = new EffectPass(
      camera,
      this.hold,
      this.bloom,
      this.vignette,
      this.noise,
      this.toneMapping,
      this.grade,
    );
    this.composer.addPass(this.mainPass);
    if (opts.smaa) {
      this.smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }));
      this.composer.addPass(this.smaaPass);
    }
    this.crossFade = new CrossFadePass();
    this.composer.addPass(this.crossFade);
    this.reducedMotion = false;
  }

  /**
   * The cross-fade pass only runs with reduced motion. Which pass writes to the screen is set explicitly,
   * because the composer only auto-assigns it to the last pass added, even when that pass is disabled.
   */
  set reducedMotion(on: boolean) {
    this.crossFade.enabled = on;
    this.crossFade.renderToScreen = on;
    (this.smaaPass ?? this.mainPass).renderToScreen = !on;
  }

  /** Reduced motion: cross-fade the next discrete change. */
  crossFadeNext(): void {
    if (this.crossFade.enabled) this.crossFade.trigger();
  }

  /** Room dim + blur while a record is held. `focus` is the held record's world position. */
  setHold(amount: number, focus: Vector3 | null): void {
    const u = this.hold.uniforms;
    u.get('amount')!.value = amount;
    this.blurCapture.enabled = amount > 0.001;
    if (focus && amount > 0) {
      const ndc = this.tmp.copy(focus).project(this.camera);
      u.get('focusDepth')!.value = ndc.z * 0.5 + 0.5;
    }
  }

  applyTuning(): void {
    this.bloom.intensity = tuning.post.bloomIntensity;
    this.bloom.luminanceMaterial.threshold = tuning.post.bloomThreshold;
    this.bloom.luminanceMaterial.smoothing = tuning.post.bloomSmoothing;
    this.vignette.darkness = tuning.post.vignette * 4.5;
    this.noise.blendMode.opacity.value = tuning.post.grain * 3;
    this.grade.uniforms.get('warmth')!.value = tuning.post.warmth;
    this.hold.uniforms.get('dim')!.value = tuning.hold.dim;
  }

  /** Whether an effect needs frames on its own (grain animates, cross-fade in progress). */
  update(dt: number): boolean {
    return this.crossFade.enabled ? this.crossFade.update(dt) : false;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height, false);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
