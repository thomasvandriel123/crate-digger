/**
 * Real-time lit materials: records (sleeves), their instanced edge LOD, divider cards, vinyl, and a generic
 * lit material for crates and the turntable. All share one lighting model and one set of light uniforms
 * (warm key from the lamp, cool rim from the window, warm ambient), so everything that moves reads as
 * part of the baked room around it.
 */

import type { Vector2 } from 'three';
import { Color, type IUniform, ShaderMaterial, type Texture, Vector3, DoubleSide, type Side } from 'three';

// --- shared lights ----------------------------------------------------------------------------------

export const lightUniforms = {
  uKeyPos: { value: new Vector3(-1.1, 2.5, 0.4) },
  uKeyColor: { value: new Color('#ffb266').multiplyScalar(5.2) },
  uRimDir: { value: new Vector3(-0.6, 0.35, -0.72).normalize() },
  uRimColor: { value: new Color('#6f86a8').multiplyScalar(0.55) },
  uAmbientUp: { value: new Color('#3a2a22').multiplyScalar(0.32) },
  uAmbientDown: { value: new Color('#140e0b').multiplyScalar(0.5) },
  /** Global sheen phase: pointer + camera drift sweep the cover sheen. */
  uSheen: { value: 0 },
};

const LIGHTING = /* glsl */ `
uniform vec3 uKeyPos;
uniform vec3 uKeyColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uAmbientUp;
uniform vec3 uAmbientDown;

vec3 shadeLit(vec3 albedo, vec3 N, vec3 V, vec3 P, float roughness, float specular) {
  vec3 L = uKeyPos - P;
  float d2 = dot(L, L);
  L *= inversesqrt(d2);
  float atten = 1.0 / (d2 + 0.35);
  float wrap = max((dot(N, L) + 0.3) / 1.3, 0.0);
  vec3 key = uKeyColor * wrap * atten;
  float ndr = max(dot(N, uRimDir), 0.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 rim = uRimColor * (0.3 * ndr + 1.6 * ndr * fres);
  vec3 amb = mix(uAmbientDown, uAmbientUp, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 H = normalize(L + V);
  float shininess = mix(6.0, 140.0, (1.0 - roughness) * (1.0 - roughness));
  float spec = pow(max(dot(N, H), 0.0), shininess) * specular * atten * (shininess + 8.0) * 0.04;
  return albedo * (key + rim + amb) + uKeyColor * spec;
}

// 4x4 ordered dither for fades that stay in the opaque pass (no sorting artefacts).
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[i] + 0.5) / 16.0;
}
`;

const COMMON_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUv;
`;

function withLights<T extends Record<string, IUniform>>(own: T): T & typeof lightUniforms {
  return { ...lightUniforms, ...own };
}

// --- generic lit material (crates, turntable, easel) --------------------------------------------------

export interface LitOptions {
  color?: string | Color;
  map?: Texture | null;
  roughness?: number;
  specular?: number;
  emissive?: string | Color;
  emissiveIntensity?: number;
  side?: Side;
  /** Multiplies the whole result (neighbour crate dimming). */
  dim?: number;
}

export class LitMaterial extends ShaderMaterial {
  constructor(opts: LitOptions = {}) {
    const hasMap = !!opts.map;
    super({
      defines: hasMap ? { USE_LIT_MAP: '' } : {},
      ...(opts.side !== undefined ? { side: opts.side } : {}),
      uniforms: withLights({
        uColor: { value: new Color(opts.color ?? '#ffffff') },
        uMap: { value: opts.map ?? null },
        uRoughness: { value: opts.roughness ?? 0.7 },
        uSpecular: { value: opts.specular ?? 0.2 },
        uEmissive: {
          value: new Color(opts.emissive ?? '#000000').multiplyScalar(opts.emissiveIntensity ?? 1),
        },
        uDim: { value: opts.dim ?? 0 },
        uOpacity: { value: 1 },
      }),
      vertexShader: /* glsl */ `
        ${COMMON_VERT}
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_VERT}
        ${LIGHTING}
        uniform vec3 uColor;
        uniform sampler2D uMap;
        uniform float uRoughness;
        uniform float uSpecular;
        uniform vec3 uEmissive;
        uniform float uDim;
        uniform float uOpacity;
        void main() {
          if (uOpacity < 0.999 && bayer4(gl_FragCoord.xy) > uOpacity) discard;
          vec3 albedo = uColor;
          #ifdef USE_LIT_MAP
            albedo *= texture2D(uMap, vUv).rgb;
          #endif
          vec3 N = normalize(vNormalW) * (gl_FrontFacing ? 1.0 : -1.0);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 col = shadeLit(albedo, N, V, vWorldPos, uRoughness, uSpecular) + uEmissive;
          gl_FragColor = vec4(col * (1.0 - uDim), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
  }

  set dim(v: number) {
    this.uniforms.uDim!.value = v;
  }

  set opacity2(v: number) {
    this.uniforms.uOpacity!.value = v;
  }
}

// --- record sleeve ------------------------------------------------------------------------------------

/** Sleeve colours from the spec: off-white card edge, paper back. */
const EDGE_COLOUR = new Color('#d9cfbd');
const PAPER_COLOUR = new Color('#e4d9c4');

const SLEEVE_FRAG_COMMON = /* glsl */ `
uniform float uSize;
uniform float uCorner;
uniform vec3 uEdgeColor;
uniform vec3 uPaperColor;
uniform float uSheen;

varying vec3 vLocal;
varying vec3 vLocalNormal;

float roundedMask(vec2 p) {
  // p: local xy with origin at the bottom centre; returns > 0 outside the rounded square.
  vec2 c = vec2(p.x, p.y - uSize * 0.5);
  vec2 q = abs(c) - vec2(uSize * 0.5 - uCorner);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uCorner;
}

vec3 edgeShade() {
  // Slightly darker toward the corners, like handled card.
  vec2 c = vec2(vLocal.x, vLocal.y - uSize * 0.5) / (uSize * 0.5);
  float corner = smoothstep(0.75, 1.0, max(abs(c.x), abs(c.y)) * min(abs(c.x), abs(c.y)) + 0.2 * max(abs(c.x), abs(c.y)));
  return uEdgeColor * (1.0 - 0.22 * corner);
}

float coverSheen(vec2 uv, vec3 V, vec3 N) {
  float phase = (uv.x + (1.0 - uv.y)) * 0.5 + dot(V, vec3(0.55, 0.35, 0.0)) * 0.8 + uSheen;
  float band = exp(-pow((fract(phase * 0.6) - 0.5) / 0.09, 2.0));
  return band * 0.055;
}
`;

const SLEEVE_VERT = /* glsl */ `
${COMMON_VERT}
varying vec3 vLocal;
varying vec3 vLocalNormal;
#ifdef EDGE_INSTANCED
  attribute vec3 aColor;
  attribute float aDim;
  varying vec3 vColor;
  varying float vDim;
#endif
void main() {
  vUv = uv;
  vLocal = position;
  vLocalNormal = normal;
  #ifdef EDGE_INSTANCED
    mat4 m = modelMatrix * instanceMatrix;
    vColor = aColor;
    vDim = aDim;
  #else
    mat4 m = modelMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export interface RecordUniforms {
  [key: string]: IUniform;
  uCover: IUniform<Texture | null>;
  uBack: IUniform<Texture | null>;
  uHasBack: IUniform<number>;
  uDominant: IUniform<Color>;
  uCoverMix: IUniform<number>;
  uWear: IUniform<Vector3>;
  uWearAmount: IUniform<number>;
  uDim: IUniform<number>;
  uOpacity: IUniform<number>;
  uRim: IUniform<number>;
}

/** One per resident record; all instances share a single compiled program. */
export class RecordMaterial extends ShaderMaterial {
  declare uniforms: RecordUniforms & typeof lightUniforms;

  constructor(size: number) {
    super({
      uniforms: withLights({
        uSize: { value: size },
        uCorner: { value: 0.0018 },
        uEdgeColor: { value: EDGE_COLOUR.clone() },
        uPaperColor: { value: PAPER_COLOUR.clone() },
        uCover: { value: null as Texture | null },
        uBack: { value: null as Texture | null },
        uHasBack: { value: 0 },
        uDominant: { value: new Color('#5e3a22') },
        uCoverMix: { value: 0 },
        uWear: { value: new Vector3(0.5, 0.5, 0.42) },
        uWearAmount: { value: 0 },
        uDim: { value: 0 },
        uOpacity: { value: 1 },
        uRim: { value: 0 },
      }),
      vertexShader: SLEEVE_VERT,
      fragmentShader: /* glsl */ `
        ${COMMON_VERT}
        ${LIGHTING}
        ${SLEEVE_FRAG_COMMON}
        uniform sampler2D uCover;
        uniform sampler2D uBack;
        uniform float uHasBack;
        uniform vec3 uDominant;
        uniform float uCoverMix;
        uniform vec3 uWear;
        uniform float uWearAmount;
        uniform float uDim;
        uniform float uOpacity;
        uniform float uRim;

        void main() {
          if (roundedMask(vLocal.xy) > 0.0) discard;
          if (uOpacity < 0.999 && bayer4(gl_FragCoord.xy) > uOpacity) discard;
          vec3 N = normalize(vNormalW);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 albedo;
          float rough = 0.6;
          float spec = 0.15;
          float sheen = 0.0;
          if (vLocalNormal.z > 0.5) {
            // Front: cover art (faded in over the dominant colour tile), ring wear, sheen.
            vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
            vec3 art = texture2D(uCover, uv).rgb;
            albedo = mix(uDominant, art, uCoverMix);
            float r = length((vUv - uWear.xy) * vec2(1.0, 1.0));
            float ring = exp(-pow((r - uWear.z) / 0.012, 2.0)) + 0.35 * exp(-pow((r - uWear.z + 0.03) / 0.02, 2.0));
            float edge = smoothstep(0.93, 1.0, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0);
            float wear = clamp(ring * 0.85 + edge * 0.5, 0.0, 1.0) * uWearAmount;
            albedo = mix(albedo, vec3(0.86, 0.82, 0.74), wear * 0.08);
            sheen = coverSheen(vUv, V, N);
          } else if (vLocalNormal.z < -0.5) {
            vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
            albedo = uHasBack > 0.5 ? texture2D(uBack, uv).rgb : uPaperColor;
            rough = 0.8;
            spec = 0.05;
          } else {
            albedo = edgeShade();
            rough = 0.85;
            spec = 0.04;
          }
          vec3 col = shadeLit(albedo, N, V, vWorldPos, rough, spec);
          col += sheen * uKeyColor * 0.08;
          // Keyboard focus: soft warm rim light on the edge.
          float fres = pow(1.0 - max(dot(N, V), 0.0), 2.0);
          col += vec3(1.0, 0.62, 0.3) * uRim * (0.25 * fres + (vLocalNormal.z > 0.5 ? 0.0 : 0.35));
          gl_FragColor = vec4(col * (1.0 - uDim), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
  }
}

/** Far records: one instanced draw, front face tinted with each album's dominant colour. */
export class EdgeMaterial extends ShaderMaterial {
  constructor(size: number) {
    super({
      defines: { EDGE_INSTANCED: '' },
      uniforms: withLights({
        uSize: { value: size },
        uCorner: { value: 0.0018 },
        uEdgeColor: { value: EDGE_COLOUR.clone() },
        uPaperColor: { value: PAPER_COLOUR.clone() },
      }),
      vertexShader: SLEEVE_VERT,
      fragmentShader: /* glsl */ `
        ${COMMON_VERT}
        ${LIGHTING}
        ${SLEEVE_FRAG_COMMON}
        varying vec3 vColor;
        varying float vDim;
        void main() {
          if (vDim < 0.0 && bayer4(gl_FragCoord.xy) > 1.0 + vDim) discard;
          vec3 N = normalize(vNormalW);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 albedo = vLocalNormal.z > 0.5 ? vColor : vLocalNormal.z < -0.5 ? uPaperColor : edgeShade();
          vec3 col = shadeLit(albedo, N, V, vWorldPos, 0.7, 0.06);
          gl_FragColor = vec4(col * (1.0 - max(vDim, 0.0)), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
  }
}

// --- divider cards ------------------------------------------------------------------------------------

/** Plastic divider cards with a printed tab; labels come from a shared canvas atlas. */
export class DividerMaterial extends ShaderMaterial {
  constructor(atlas: Texture, cells: Vector2) {
    super({
      defines: { EDGE_INSTANCED: '' },
      side: DoubleSide,
      uniforms: withLights({
        uAtlas: { value: atlas },
        uCells: { value: cells },
        uCard: { value: new Color('#cfc6b4') },
      }),
      vertexShader: /* glsl */ `
        ${COMMON_VERT}
        attribute float aCell;
        attribute float aTab;
        attribute float aDim;
        attribute vec3 aColor;
        attribute float aIsTab;
        varying float vCell;
        varying float vIsTab;
        varying float vDim;
        varying vec3 vColor;
        varying vec3 vLocalNormal;
        void main() {
          vUv = uv;
          vCell = aCell;
          vIsTab = aIsTab;
          vDim = aDim;
          vColor = aColor;
          vLocalNormal = normal;
          vec3 p = position;
          p.x += aIsTab * aTab;
          mat4 m = modelMatrix * instanceMatrix;
          vec4 wp = m * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(m) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_VERT}
        ${LIGHTING}
        uniform sampler2D uAtlas;
        uniform vec2 uCells;
        uniform vec3 uCard;
        varying float vCell;
        varying float vIsTab;
        varying float vDim;
        varying vec3 vColor;
        varying vec3 vLocalNormal;
        void main() {
          if (vDim < 0.0 && bayer4(gl_FragCoord.xy) > 1.0 + vDim) discard;
          vec3 N = normalize(vNormalW) * (gl_FrontFacing ? 1.0 : -1.0);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 albedo = mix(uCard, vColor, 0.18);
          if (vIsTab > 0.5 && abs(vLocalNormal.z) > 0.5 && vUv.y > 0.001) {
            vec2 uv = vUv;
            if (!gl_FrontFacing) uv.x = 1.0 - uv.x;
            float col = mod(vCell, uCells.x);
            float row = floor(vCell / uCells.x);
            vec2 auv = (vec2(col, row) + vec2(uv.x, 1.0 - uv.y)) / uCells;
            vec4 ink = texture2D(uAtlas, auv);
            albedo = mix(albedo, ink.rgb, ink.a);
          }
          vec3 col = shadeLit(albedo, N, V, vWorldPos, 0.35, 0.35);
          gl_FragColor = vec4(col * (1.0 - max(vDim, 0.0)), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
  }
}

// --- vinyl --------------------------------------------------------------------------------------------

export const MAX_GAPS = 24;

/**
 * Black vinyl with analytic grooves (anti-aliased with fwidth, so no normal-map texture), silent gaps
 * between tracks placed from the real track durations, and two opposing wedge highlights: the faked
 * anisotropic streak. The streak angle is given in disc space, so the caller decides whether it stays
 * fixed in the world (still) or travels with the disc (playing).
 */
export interface VinylUniforms {
  [key: string]: IUniform;
  uLabel: IUniform<Texture | null>;
  uHasLabel: IUniform<number>;
  uLabelColor: IUniform<Color>;
  uStreak: IUniform<number>;
  uGaps: IUniform<Float32Array>;
  uGapCount: IUniform<number>;
  uOpacity: IUniform<number>;
  uDim: IUniform<number>;
}

export class VinylMaterial extends ShaderMaterial {
  declare uniforms: VinylUniforms & typeof lightUniforms;

  constructor() {
    super({
      uniforms: withLights({
        uLabel: { value: null as Texture | null },
        uHasLabel: { value: 0 },
        uLabelColor: { value: new Color('#a34c2b') },
        uStreak: { value: 0 },
        uGaps: { value: new Float32Array(MAX_GAPS) },
        uGapCount: { value: 0 },
        uOpacity: { value: 1 },
        uDim: { value: 0 },
      }),
      vertexShader: /* glsl */ `
        ${COMMON_VERT}
        varying vec3 vLocal;
        varying vec3 vLocalNormal;
        varying vec3 vRadialW;
        void main() {
          vUv = uv;
          vLocal = position;
          vLocalNormal = normal;
          // World-space radial direction (linear in position, so it interpolates exactly).
          vRadialW = mat3(modelMatrix) * vec3(position.x, 0.0, position.z);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COMMON_VERT}
        ${LIGHTING}
        varying vec3 vRadialW;
        #define MAX_GAPS ${MAX_GAPS}
        uniform sampler2D uLabel;
        uniform float uHasLabel;
        uniform vec3 uLabelColor;
        uniform float uStreak;
        uniform float uGaps[MAX_GAPS];
        uniform int uGapCount;
        uniform float uOpacity;
        uniform float uDim;
        varying vec3 vLocal;
        varying vec3 vLocalNormal;

        const float R_OUT = 0.1525;
        const float R_LABEL = 0.05;
        const float R_HOLE = 0.0035;

        void main() {
          if (uOpacity < 0.999 && bayer4(gl_FragCoord.xy) > uOpacity) discard;
          // Disc lies in local XZ; faces point +Y / -Y.
          vec2 p = vLocal.xz;
          float r = length(p);
          if (r < R_HOLE || r > R_OUT) discard;
          vec3 N = normalize(vNormalW);
          vec3 V = normalize(cameraPosition - vWorldPos);
          bool face = abs(vLocalNormal.y) > 0.5;
          vec3 col;
          if (face && r < R_LABEL) {
            vec2 luv = p / (2.0 * R_LABEL) + 0.5;
            if (vLocalNormal.y < 0.0) luv.x = 1.0 - luv.x;
            vec3 lab = uHasLabel > 0.5 ? texture2D(uLabel, vec2(luv.x, luv.y)).rgb : uLabelColor;
            col = shadeLit(lab, N, V, vWorldPos, 0.65, 0.1);
          } else {
            float theta = atan(p.y, p.x);
            // Grooves: fine concentric ridges; fade to flat where they alias.
            float freq = 1400.0;
            float w = fwidth(r * freq);
            float ridge = sin(r * freq * 6.2831) * (1.0 - smoothstep(0.35, 0.9, w));
            float gap = 0.0;
            for (int i = 0; i < MAX_GAPS; i++) {
              if (i >= uGapCount) break;
              gap = max(gap, 1.0 - smoothstep(0.0, 0.0012, abs(r - uGaps[i])));
            }
            float runout = smoothstep(0.062, 0.058, r) + smoothstep(0.1495, 0.1515, r);
            float grooved = face ? (1.0 - max(gap, runout)) : 0.0;
            vec3 radial = normalize(vRadialW + 1e-6);
            vec3 Ng = normalize(N + radial * ridge * 0.06 * grooved);
            vec3 black = vec3(0.012, 0.011, 0.012);
            col = shadeLit(black, Ng, V, vWorldPos, mix(0.2, 0.35, grooved), 0.9);
            // Two opposing wedges of light across the grooves.
            float a = abs(cos(theta - uStreak));
            float wedge = pow(a, 38.0) * (0.35 + 0.65 * grooved) * smoothstep(R_LABEL + 0.004, R_LABEL + 0.02, r);
            float glint = wedge * (0.55 + 0.45 * ridge * grooved);
            col += uKeyColor * glint * 0.018 * (face ? 1.0 : 0.0);
          }
          gl_FragColor = vec4(col * (1.0 - uDim), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
  }
}

export function setLights(opts: { key: number; rim: number; ambient: number; keyPos?: Vector3 }): void {
  // Color.set() converts sRGB hex into the linear working space (three's colour management).
  lightUniforms.uKeyColor.value.set('#ffb266').multiplyScalar(opts.key);
  lightUniforms.uRimColor.value.set('#6f86a8').multiplyScalar(opts.rim);
  lightUniforms.uAmbientUp.value.set('#5a4032').multiplyScalar(opts.ambient);
  lightUniforms.uAmbientDown.value.set('#2b1f1a').multiplyScalar(opts.ambient * 0.6);
  if (opts.keyPos) lightUniforms.uKeyPos.value.copy(opts.keyPos);
}
