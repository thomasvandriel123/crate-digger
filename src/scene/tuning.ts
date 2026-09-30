/**
 * Every number that shapes the feel, in one mutable object. The dev-only lil-gui panel edits it live
 * (see devtools.ts); production reads the same defaults. Units: metres, degrees, seconds.
 */
export const tuning = {
  fan: {
    /** Spacing between records far from the focus. */
    restSpacing: 0.012,
    /** Spacing of the flipped stack in front of the focus. */
    passedSpacing: 0.006,
    /** Extra spacing that opens behind the focus, decaying with `aheadHalfWidth`. */
    aheadExtra: 0.028,
    aheadHalfWidth: 3,
    /** Air around the focus record so its lean never cuts into its neighbours. */
    focusGap: 0.03,
    focusLift: 0.1,
    /** Negative leans toward the camera. */
    focusLean: -10,
    restLean: 10,
    aheadLean: 18,
    passedLean: -14,
    sinkDepth: 0.12,
    /**
     * Raked floor: each record behind the focus stands this much higher, saturating after `rakeRecords`,
     * then easing back down from `rakeFade` records on, so the back of a full crate never towers over the
     * sideboard behind it.
     */
    rakePerRecord: 0.02,
    rakeRecords: 6,
    rakeFade: 14,
    hoverLift: 0.015,
    hoverTilt: 3,
    /** Fan strength in neighbour crates (1 = same as active). */
    neighbourFan: 0.35,
    /** Records within this distance of the focus render as full meshes; beyond, as instanced edges. */
    fullRadius: 10,
    neighbourFullRadius: 4,
    /** Textures load within this radius (spec: 12 active, 4 neighbours). */
    textureRadius: 12,
    neighbourTextureRadius: 4,
  },
  crate: {
    /** Centre-to-centre distance between bins in the row. */
    spacing: 0.5,
    /** Neighbour bins turn inward by this much. */
    inwardTurn: 12,
    neighbourDim: 0.35,
    /** Bins stand on legs; this is the inner floor height. */
    floorY: 0.56,
    wallHeight: 0.25,
    frontWallHeight: 0.19,
    /** Records stand on a riser this high above the bin floor (room to sink). */
    riserY: 0.09,
    innerWidth: 0.335,
    frontMargin: 0.02,
    /** The row's centre (active bin) in world space. */
    rowZ: -1.5,
    /** Bins angle slightly toward the camera. */
    tilt: 4,
  },
  camera: {
    fov: 35,
    height: 1.6,
    pitch: 25,
    z: 0,
    parallaxYaw: 2,
    parallaxPitch: 1,
    driftDeg: 0.3,
    driftPeriod: 23,
    dolly: 0.12,
    /** Phone portrait rig. */
    portraitPitch: 38,
    portraitHeight: 1.75,
  },
  hold: {
    /** Fraction of the view height the held record should fill. */
    screenFill: 0.47,
    sway: 2,
    pullMs: 550,
    returnMs: 500,
    flipMs: 600,
    flipOvershoot: 3,
    dimMs: 300,
    dim: 0.25,
    blur: 1,
  },
  post: {
    bloomIntensity: 0.9,
    bloomThreshold: 0.82,
    bloomSmoothing: 0.25,
    vignette: 0.1,
    grain: 0.02,
    warmth: 0.05,
    exposure: 1.0,
  },
  lights: {
    key: 5.2,
    rim: 0.55,
    ambient: 0.32,
  },
};

export type Tuning = typeof tuning;
