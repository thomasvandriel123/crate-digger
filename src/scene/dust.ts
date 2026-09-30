/**
 * Up to 60 dust motes drifting in the lamp's light cone. All motion is in the vertex shader (one time
 * uniform), so the CPU cost is nil and the idle tick keeps them alive at 15 fps. Off with reduced motion.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  type Vector3,
} from 'three';
import { mulberry32 } from '../data/random';
import { moteTexture } from './textures';

export class Dust {
  readonly points: Points;
  private material: ShaderMaterial;
  private texture: CanvasTexture;
  private time = 0;

  constructor(lamp: Vector3, count = 60) {
    const rand = mulberry32(99);
    const base = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // Mostly in the pool below the shade, a few in the upward spill and drifting toward the room.
      const down = rand() < 0.75;
      const h = down ? -0.03 - rand() * 0.3 : 0.08 + rand() * 0.35;
      const r = (down ? 0.06 + Math.abs(h) * 0.9 : 0.05 + h * 0.6) * Math.sqrt(rand());
      const a = rand() * Math.PI * 2;
      base[i * 3] = lamp.x + Math.cos(a) * r + (rand() < 0.3 ? 0.2 : 0);
      base[i * 3 + 1] = lamp.y + h;
      base[i * 3 + 2] = lamp.z + Math.sin(a) * r + rand() * 0.25;
      seed[i * 4] = 0.15 + rand() * 0.35;
      seed[i * 4 + 1] = 0.1 + rand() * 0.3;
      seed[i * 4 + 2] = rand();
      seed[i * 4 + 3] = rand() * 100;
    }
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(base, 3));
    geom.setAttribute('aSeed', new Float32BufferAttribute(seed, 4));
    this.texture = new CanvasTexture(moteTexture() as HTMLCanvasElement);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uLamp: { value: lamp.clone() },
        uMap: { value: this.texture },
        uColor: { value: new Color('#ffcf99').multiplyScalar(0.9) },
        uScale: { value: 1 },
        uIntensity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform vec3 uLamp;
        uniform float uScale;
        uniform float uIntensity;
        varying float vAlpha;
        void main() {
          float t = uTime;
          vec3 p = position + vec3(
            sin(t * aSeed.x + aSeed.w) * 0.035,
            sin(t * aSeed.y * 0.6 + aSeed.w * 1.7) * 0.03,
            cos(t * aSeed.x * 0.8 + aSeed.w * 0.9) * 0.03
          );
          vec3 d = p - uLamp;
          float below = -d.y;
          float r = length(d.xz);
          float inPool = smoothstep(0.0, 0.04, below) * (1.0 - smoothstep(0.1 + below * 0.8, 0.2 + below * 1.1, r));
          float inSpill = smoothstep(0.06, 0.12, d.y) * (1.0 - smoothstep(0.08 + d.y * 0.5, 0.16 + d.y * 0.7, r));
          float twinkle = 0.55 + 0.45 * sin(t * (0.6 + aSeed.x * 2.0) + aSeed.w * 3.0);
          vAlpha = max(inPool, inSpill * 0.6) * twinkle * uIntensity;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (1.4 + aSeed.z * 2.2) * uScale / -mv.z;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a, 1.0);
        }
      `,
    });
    this.points = new Points(geom, this.material);
    this.points.frustumCulled = false;
  }

  set visible(v: boolean) {
    this.points.visible = v;
  }

  /** Point size scales with the drawing buffer height so motes look the same at any resolution. */
  setViewportHeight(px: number): void {
    this.material.uniforms.uScale!.value = px * 0.0045;
  }

  update(dt: number): void {
    this.time += dt;
    this.material.uniforms.uTime!.value = this.time;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
