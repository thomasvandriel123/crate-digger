/**
 * The room, built procedurally from primitives with baked lighting. The boundary is `buildRoom()` returning
 * a group plus a few anchors, so a hand-modelled glTF can replace it later without touching anything else.
 *
 * Layout (metres, camera at the origin looking down -z): crates around z = -1.5, a walnut sideboard against
 * the back wall at z = -3.2 carrying the turntable, speakers, lamp and easel; a night window on the left,
 * a plant on the right, a rug under the crates.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from 'three';
import { mulberry32 } from '../data/random';
import { bakeLightmap, type BakeEnv, irradiance, ROOM_LIGHT, type Surface, type V3 } from './bake';
import {
  blobTexture,
  type Canvas,
  ctx2d,
  floorAlbedo,
  grilleTexture,
  hex,
  leafTexture,
  makeCanvas,
  nightWindowTexture,
  paint,
  plasterAlbedo,
  printTexture,
  rugAlbedo,
  woodAlbedo,
} from './textures';

export const ROOM = {
  wallZ: -3.2,
  sideboard: { x0: -1.0, x1: 1.0, y0: 0.14, y1: 0.74, z0: -3.18, z1: -2.72 },
  lamp: new Vector3(-0.62, 1.06, -2.95),
  /**
   * The real-time key for records, crates and deck: warm, above and in front, left of the camera, as if a
   * second lamp stood behind you. The table lamp itself is behind the crates and would only backlight covers.
   */
  key: new Vector3(-1.1, 2.5, 0.4),
  turntable: new Vector3(0.42, 0.74, -2.93),
  easel: new Vector3(-0.12, 0.74, -2.9),
  window: { x0: -2.25, x1: -1.12, y0: 0.55, y1: 2.3 },
  plant: new Vector3(-1.32, 0, -2.75),
};

export interface Room {
  group: Group;
  /** Warm point where the real-time key light lives (the lamp bulb). */
  lampPosition: Vector3;
  dispose(): void;
}

function canvasTexture(canvas: Canvas, repeat: [number, number] = [1, 1]): CanvasTexture {
  const t = new CanvasTexture(canvas as HTMLCanvasElement);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat[0] !== 1 || repeat[1] !== 1) {
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** A plane with albedo + baked lightmap. Surface basis is derived from the mesh's final transform. */
function bakedPlane(
  env: BakeEnv,
  width: number,
  height: number,
  map: Texture,
  place: (m: Mesh) => void,
  res: [number, number],
  ao?: Surface['ao'],
  tint = '#ffffff',
): Mesh {
  const geom = new PlaneGeometry(width, height);
  const mat = new MeshBasicMaterial({ map, color: new Color(tint) });
  const mesh = new Mesh(geom, mat);
  place(mesh);
  mesh.updateMatrixWorld(true);
  const o = new Vector3(-width / 2, -height / 2, 0).applyMatrix4(mesh.matrixWorld);
  const ux = new Vector3(width / 2, -height / 2, 0).applyMatrix4(mesh.matrixWorld).sub(o);
  const vy = new Vector3(-width / 2, height / 2, 0).applyMatrix4(mesh.matrixWorld).sub(o);
  const n = new Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
  const lm = bakeLightmap(
    {
      origin: o.toArray() as V3,
      u: ux.toArray() as V3,
      v: vy.toArray() as V3,
      normal: n.toArray() as V3,
      resU: res[0],
      resV: res[1],
      ao,
    },
    env,
  );
  mat.lightMap = lm;
  mat.lightMapIntensity = Math.PI;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Per-vertex baked lighting for small props (a few dozen vertices each). */
function bakeVertexColours(geometry: BufferGeometry, mesh: Mesh, env: BakeEnv, albedo: string): void {
  mesh.updateMatrixWorld(true);
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const a = hex(albedo).map((c) => Math.pow(c, 2.2)) as [number, number, number];
  const colours = new Float32Array(pos.count * 3);
  const p = new Vector3();
  const n = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    n.fromBufferAttribute(nor, i).transformDirection(mesh.matrixWorld);
    const e = irradiance(p.toArray() as V3, n.toArray() as V3, {
      ...env,
      occluders: env.occluders.slice(0, 1),
    });
    colours[i * 3] = a[0] * e[0];
    colours[i * 3 + 1] = a[1] * e[1];
    colours[i * 3 + 2] = a[2] * e[2];
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
}

function prop(
  geometry: BufferGeometry,
  env: BakeEnv,
  albedo: string,
  place: (m: Mesh) => void,
  map?: Texture,
): Mesh {
  const mat = new MeshBasicMaterial({ vertexColors: true, map: map ?? null });
  const mesh = new Mesh(geometry, mat);
  place(mesh);
  bakeVertexColours(geometry, mesh, env, albedo);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

function sideboardFront(): Canvas {
  const w = 512;
  const h = 160;
  const wood = woodAlbedo(11, '#7a4d2e', '#4f301b', 0.7);
  const canvas = paint(w, h, (u, v) => wood(u, v * 0.3));
  const ctx = ctx2d(canvas);
  // Three doors with a slatted centre panel and small brass pulls.
  ctx.strokeStyle = 'rgba(20, 12, 8, 0.85)';
  ctx.lineWidth = 2;
  for (const x of [w / 3, (2 * w) / 3]) {
    ctx.beginPath();
    ctx.moveTo(x, 6);
    ctx.lineTo(x, h - 6);
    ctx.stroke();
  }
  ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.strokeStyle = 'rgba(20, 12, 8, 0.45)';
  for (let x = w / 3 + 10; x < (2 * w) / 3 - 6; x += 9) {
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x, h - 14);
    ctx.stroke();
  }
  ctx.fillStyle = '#b08a4a';
  for (const x of [w / 3 - 14, (2 * w) / 3 + 10]) ctx.fillRect(x, h / 2 - 10, 4, 20);
  return canvas;
}

export function buildRoom(): Room {
  const group = new Group();
  group.name = 'room';
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    disposables.push(x);
    return x;
  };

  const sb = ROOM.sideboard;
  const env: BakeEnv = {
    lamp: { position: ROOM.lamp.toArray() as V3, colour: ROOM_LIGHT.lampColour, intensity: 1.35 },
    window: {
      position: [
        (ROOM.window.x0 + ROOM.window.x1) / 2,
        (ROOM.window.y0 + ROOM.window.y1) / 2,
        ROOM.wallZ + 0.05,
      ],
      normal: [0, 0, 1],
      colour: ROOM_LIGHT.windowColour,
      intensity: 0.5,
      size: [ROOM.window.x1 - ROOM.window.x0, ROOM.window.y1 - ROOM.window.y0],
    },
    ambient: [0.022, 0.016, 0.013],
    occluders: [
      { min: [sb.x0, sb.y0, sb.z0], max: [sb.x1, sb.y1 - 0.005, sb.z1] },
      { min: [-1.0, 0.74, -3.14], max: [-0.8, 1.06, -2.9] }, // left speaker
      { min: [0.76, 0.74, -3.14], max: [0.96, 1.06, -2.9] }, // right speaker
    ],
  };

  // Floor: planks, darker toward the walls.
  const floor = bakedPlane(
    env,
    8,
    4.8,
    track(canvasTexture(paint(512, 512, floorAlbedo(3, 18)), [3, 2])),
    (m) => {
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0, -0.8);
    },
    [128, 80],
    (p) => 1 - 0.4 * Math.exp(-(p[2] - ROOM.wallZ) / 0.25),
  );
  group.add(floor);

  // Rug under the crates: the one saturated warm accent.
  const rug = bakedPlane(
    env,
    2.9,
    2.1,
    track(canvasTexture(paint(512, 384, rugAlbedo(5)))),
    (m) => {
      m.rotation.x = -Math.PI / 2;
      m.position.set(0.05, 0.004, -1.62);
    },
    [96, 72],
    undefined,
    '#b3a49a',
  );
  group.add(rug);

  // Back wall.
  const wall = bakedPlane(
    env,
    9,
    3,
    track(canvasTexture(paint(512, 256, plasterAlbedo(9)), [2, 1])),
    (m) => m.position.set(0, 1.5, ROOM.wallZ),
    [160, 60],
    (p) => (1 - 0.45 * Math.exp(-p[1] / 0.18)) * (1 - 0.25 * Math.exp(-(2.8 - p[1]) / 0.4)),
  );
  group.add(wall);

  // Skirting board.
  const skirting = prop(new BoxGeometry(9, 0.1, 0.02), env, '#2a1c15', (m) =>
    m.position.set(0, 0.05, ROOM.wallZ + 0.01),
  );
  group.add(skirting);

  // Night window: bokeh city (unlit, a touch emissive), frame, mullions, sill.
  const w = ROOM.window;
  const winW = w.x1 - w.x0;
  const winH = w.y1 - w.y0;
  const glass = new Mesh(
    new PlaneGeometry(winW, winH),
    new MeshBasicMaterial({
      map: track(canvasTexture(nightWindowTexture(21))),
      color: new Color(0.62, 0.66, 0.78),
    }),
  );
  glass.position.set((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, ROOM.wallZ + 0.004);
  group.add(glass);
  const frameColour = '#1c1411';
  const bar = (bw: number, bh: number, x: number, y: number, z = ROOM.wallZ + 0.025, d = 0.05) =>
    group.add(prop(new BoxGeometry(bw, bh, d), env, frameColour, (m) => m.position.set(x, y, z)));
  bar(winW + 0.1, 0.06, (w.x0 + w.x1) / 2, w.y1 + 0.03);
  bar(winW + 0.1, 0.05, (w.x0 + w.x1) / 2, w.y0 - 0.025);
  bar(0.06, winH, w.x0 - 0.03, (w.y0 + w.y1) / 2);
  bar(0.06, winH, w.x1 + 0.03, (w.y0 + w.y1) / 2);
  bar(0.035, winH, (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, ROOM.wallZ + 0.02, 0.03);
  bar(winW, 0.03, (w.x0 + w.x1) / 2, w.y0 + winH * 0.62, ROOM.wallZ + 0.02, 0.03);
  group.add(
    prop(new BoxGeometry(winW + 0.24, 0.035, 0.2), env, '#3a271d', (m) =>
      m.position.set((w.x0 + w.x1) / 2, w.y0 - 0.06, ROOM.wallZ + 0.06),
    ),
  );
  // Sideboard: walnut, mid-century, three doors.
  const topMap = track(canvasTexture(paint(512, 128, woodAlbedo(7, '#8a5a36', '#5e3a22', 1.4))));
  const sideMap = track(canvasTexture(paint(128, 128, woodAlbedo(8, '#7d5031', '#56341e'))));
  const frontMap = track(canvasTexture(sideboardFront()));
  const sbW = sb.x1 - sb.x0;
  const sbH = sb.y1 - sb.y0;
  const sbD = sb.z1 - sb.z0;
  const sbX = (sb.x0 + sb.x1) / 2;
  const sbZ = (sb.z0 + sb.z1) / 2;
  group.add(
    bakedPlane(
      env,
      sbW + 0.02,
      sbD + 0.02,
      topMap,
      (m) => {
        m.rotation.x = -Math.PI / 2;
        m.position.set(sbX, sb.y1, sbZ + 0.01);
      },
      [96, 24],
      (p) => 1 - 0.3 * Math.exp(-(p[2] - sb.z0) / 0.05),
    ),
  );
  group.add(
    bakedPlane(
      env,
      sbW,
      sbH - 0.03,
      frontMap,
      (m) => m.position.set(sbX, sb.y0 + (sbH - 0.03) / 2, sb.z1),
      [64, 24],
    ),
  );
  // Top edge band.
  group.add(
    bakedPlane(
      env,
      sbW + 0.02,
      0.03,
      topMap,
      (m) => m.position.set(sbX, sb.y1 - 0.015, sb.z1 + 0.01),
      [64, 2],
    ),
  );
  for (const side of [-1, 1] as const) {
    group.add(
      bakedPlane(
        env,
        sbD,
        sbH,
        sideMap,
        (m) => {
          m.rotation.y = (side * Math.PI) / 2;
          m.position.set(side < 0 ? sb.x0 : sb.x1, sb.y0 + sbH / 2, sbZ);
        },
        [16, 16],
      ),
    );
  }
  // Tapered legs.
  const legGeom = new CylinderGeometry(0.018, 0.011, sb.y0 + 0.02, 8);
  for (const [x, z] of [
    [sb.x0 + 0.08, sb.z1 - 0.06],
    [sb.x1 - 0.08, sb.z1 - 0.06],
    [sb.x0 + 0.08, sb.z0 + 0.06],
    [sb.x1 - 0.08, sb.z0 + 0.06],
  ] as const) {
    group.add(prop(legGeom.clone(), env, '#3a2416', (m) => m.position.set(x, (sb.y0 + 0.02) / 2, z)));
  }

  // Speakers.
  const grille = track(canvasTexture(grilleTexture(4)));
  for (const x of [-0.9, 0.86]) {
    const body = new BoxGeometry(0.2, 0.32, 0.24);
    group.add(prop(body, env, '#4a2f1e', (m) => m.position.set(x, sb.y1 + 0.16, -2.98)));
    group.add(
      prop(
        new PlaneGeometry(0.17, 0.29),
        env,
        '#8a8078',
        (m) => m.position.set(x, sb.y1 + 0.16, -2.859),
        grille,
      ),
    );
  }

  // Lamp: ceramic base, brass stem, glowing linen shade. The shade is HDR so bloom picks it up.
  const lx = ROOM.lamp.x;
  const lz = ROOM.lamp.z;
  group.add(
    prop(new CylinderGeometry(0.05, 0.075, 0.16, 20), env, '#6b5646', (m) =>
      m.position.set(lx, sb.y1 + 0.08, lz),
    ),
  );
  group.add(
    prop(new CylinderGeometry(0.008, 0.008, 0.2, 8), env, '#b8924f', (m) =>
      m.position.set(lx, sb.y1 + 0.22, lz),
    ),
  );
  const shade = new Mesh(
    new CylinderGeometry(0.1, 0.15, 0.19, 32, 1, true),
    new MeshBasicMaterial({ color: new Color('#ffb266').multiplyScalar(2.6), side: DoubleSide }),
  );
  shade.position.set(lx, 1.085, lz);
  group.add(shade);
  const inner = new Mesh(
    new CylinderGeometry(0.098, 0.148, 0.188, 32, 1, true),
    new MeshBasicMaterial({ color: new Color('#ffd9a8').multiplyScalar(5.5), side: DoubleSide }),
  );
  inner.position.copy(shade.position);
  inner.scale.setScalar(0.99);
  group.add(inner);
  // Fake light pools: soft additive cones above and below the shade.
  const coneMat = new MeshBasicMaterial({
    map: track(canvasTexture(coneGradient())),
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    color: new Color('#ffb266').multiplyScalar(0.22),
  });
  const coneDown = new Mesh(new CylinderGeometry(0.15, 0.34, 0.33, 32, 1, true), coneMat);
  coneDown.position.set(lx, 0.99 - 0.165, lz);
  group.add(coneDown);

  // Contact shadows (blob textures, never shadow maps).
  const blob = track(canvasTexture(blobTexture()));
  const blobMat = new MeshBasicMaterial({ map: blob, transparent: true, depthWrite: false, opacity: 0.85 });
  const addBlob = (x: number, y: number, z: number, sx: number, sz: number) => {
    const m = new Mesh(new PlaneGeometry(sx, sz), blobMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y + 0.003, z);
    group.add(m);
  };
  addBlob(sbX, 0, sbZ + 0.05, sbW + 0.35, sbD + 0.4);
  addBlob(lx, sb.y1, lz, 0.22, 0.22);
  addBlob(-0.9, sb.y1, -2.98, 0.3, 0.32);
  addBlob(0.86, sb.y1, -2.98, 0.3, 0.32);
  addBlob(ROOM.plant.x, 0, ROOM.plant.z, 0.55, 0.55);

  // Shelf with a few records leaning and a small stack of books.
  const shelfY = 1.2;
  group.add(
    prop(new BoxGeometry(1.5, 0.03, 0.2), env, '#5e3a22', (m) =>
      m.position.set(0.2, shelfY, ROOM.wallZ + 0.1),
    ),
  );
  const spines = ['#7a3b2e', '#2f4f5f', '#c9a15a', '#3d3a36', '#8a5a36', '#56423a'];
  spines.forEach((c, i) => {
    group.add(
      prop(new BoxGeometry(0.012 + (i % 2) * 0.006, 0.26, 0.2), env, c, (m) => {
        m.position.set(-0.4 + i * 0.022, shelfY + 0.145, ROOM.wallZ + 0.1);
        m.rotation.z = i === 5 ? -0.12 : 0;
      }),
    );
  });

  // Two framed prints above the sideboard.
  const frames: [number, number, number, number, number][] = [
    [-0.08, 1.52, 0.4, 0.5, 31],
    [0.58, 1.5, 0.32, 0.4, 32],
  ];
  for (const [x, y, fw, fh, seed] of frames) {
    group.add(
      prop(new BoxGeometry(fw + 0.04, fh + 0.04, 0.025), env, '#1f1814', (m) =>
        m.position.set(x, y, ROOM.wallZ + 0.014),
      ),
    );
    const tint = irradiance([x, y, ROOM.wallZ + 0.03], [0, 0, 1], env);
    const art = new Mesh(
      new PlaneGeometry(fw, fh),
      new MeshBasicMaterial({
        map: track(canvasTexture(printTexture(seed))),
        color: new Color(tint[0], tint[1], tint[2]),
      }),
    );
    art.position.set(x, y, ROOM.wallZ + 0.0275);
    group.add(art);
  }

  // Plant: terracotta pot and a loose cluster of leaves.
  const px = ROOM.plant.x;
  const pz = ROOM.plant.z;
  group.add(
    prop(new CylinderGeometry(0.16, 0.12, 0.34, 20), env, '#8a4a30', (m) => m.position.set(px, 0.17, pz)),
  );
  const leafMap = track(canvasTexture(leafTexture()));
  const leafMat = new MeshBasicMaterial({
    map: leafMap,
    alphaTest: 0.5,
    side: DoubleSide,
    vertexColors: true,
  });
  const rand = mulberry32(77);
  for (let i = 0; i < 26; i++) {
    const g = new PlaneGeometry(0.16 + rand() * 0.1, 0.34 + rand() * 0.2);
    const leaf = new Mesh(g, leafMat);
    const h = 0.45 + rand() * 0.75;
    const a = rand() * Math.PI * 2;
    const r = 0.04 + rand() * 0.22;
    leaf.position.set(px + Math.cos(a) * r, h, pz + Math.sin(a) * r * 0.7);
    leaf.rotation.set(-0.3 + rand() * 0.6, a, (rand() - 0.5) * 1.2);
    bakeVertexColours(g, leaf, env, '#ffffff');
    leaf.matrixAutoUpdate = false;
    leaf.updateMatrix();
    group.add(leaf);
  }

  group.traverse((o) => {
    if (o instanceof Mesh) {
      disposables.push(o.geometry);
      disposables.push(o.material as Material);
    }
  });

  return {
    group,
    lampPosition: ROOM.lamp.clone(),
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}

function coneGradient(): Canvas {
  const c = makeCanvas(8, 128);
  const ctx = ctx2d(c);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 128);
  return c;
}
