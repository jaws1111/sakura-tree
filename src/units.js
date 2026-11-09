/**
 * SI / metric contract for the sakura engine.
 * 1 Three.js world unit === 1 metre. Never mix cm meshes into this scene.
 * Botanical defaults: mature ornamental Prunus serrulata / Kanzan-class.
 */

export const MM = 0.001;
export const CM = 0.01;

/** Gravity vector (m·s⁻²). */
export const G_EARTH = Object.freeze({ x: 0, y: -9.81, z: 0 });

/** Hero tree — metres */
export const TREE_HEIGHT_M = 9.0;
export const CROWN_RADIUS_M = 4.0;
export const CROWN_SPREAD_M = CROWN_RADIUS_M * 2;
export const Y_FORK_M = 2.0;
export const TRUNK_BASE_RADIUS_M = 0.2;
export const TRUNK_DBH_RADIUS_M = 0.14;
export const TWIG_MIN_RADIUS_M = 0.003;
export const BARK_GROOVE_AMP_M = 0.004;
export const LENTICEL_PITCH_M = 0.015;

/**
 * Root system (metres) — ornamental cherry is relatively shallow/spreading.
 * Collar at y=0; roots occupy y < 0 (underground).
 */
export const ROOT_DEPTH_M = 1.2;           // lateral root zone depth
export const TAPROOT_DEPTH_M = 1.6;        // central tap / sinker
export const ROOT_SPREAD_M = CROWN_RADIUS_M * 1.05; // ≈ drip-line
export const ROOT_BASE_RADIUS_M = 0.11;    // primary lateral at collar
export const ROOT_TIP_RADIUS_M = 0.005;
export const TAPROOT_TIP_RADIUS_M = 0.012;

/** Flowers / petals — metres */
export const PETAL_LENGTH_M = 18 * MM;
export const PETAL_WIDTH_M = 14 * MM;
export const FLOWER_DIAMETER_M = 0.036;
export const CLUSTER_SPAN_M = 0.12;

/** Atmosphere / physics — SI */
export const WIND_AMBIENT_MPS = 1.5;
export const WIND_GUST_MPS = 5.0;
export const V_TERM_PETAL_MPS = 0.9;

/** Environment — metres */
export const PARK_EXTENT_M = 40;
export const CAMERA_EYE_M = 1.6;
export const GRASS_HEIGHT_MIN_M = 0.08;
export const GRASS_HEIGHT_MAX_M = 0.18;
export const GRASS_WIDTH_M = 0.004;
export const MOSS_STRAND_MIN_M = 0.005;
export const MOSS_STRAND_MAX_M = 0.015;

/** SDF / meshing — metres */
export const SDF_HIT_EPS_M = 5e-4;
export const SDF_VOXEL_TRUNK_M = 0.025;

export const UNITS = Object.freeze({
  worldUnit: 'metre',
  timeUnit: 'second',
  gravity: G_EARTH,
  tree: {
    height: TREE_HEIGHT_M,
    crownRadius: CROWN_RADIUS_M,
    forkY: Y_FORK_M,
    trunkBaseRadius: TRUNK_BASE_RADIUS_M,
    trunkDbhRadius: TRUNK_DBH_RADIUS_M,
    twigMinRadius: TWIG_MIN_RADIUS_M,
    rootDepth: ROOT_DEPTH_M,
    taprootDepth: TAPROOT_DEPTH_M,
    rootSpread: ROOT_SPREAD_M,
    rootBaseRadius: ROOT_BASE_RADIUS_M
  },
  petal: {
    length: PETAL_LENGTH_M,
    width: PETAL_WIDTH_M,
    flowerDiameter: FLOWER_DIAMETER_M
  }
});
