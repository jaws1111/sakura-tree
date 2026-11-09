/**
 * Interactive triangle / instance budget for the sakura scene.
 *
 * Budget caps are the safety net. Prefer *eliminating* unneeded tris via:
 *  - Bark: vertex clustering after MC (display Nyquist ≫ voxel noise)
 *  - Canopy: dual LOD + screen-space projected-size cull (Clark)
 *  - Grass: exponential distance density ρ=exp(−(d−d0)/λ)
 *  - Twigs: skip MC when r < 1.5·voxel (feature below recoverable freq)
 *
 * Soft cap keeps mid-range GPUs near 60 FPS; hard cap refuses suicide configs.
 */

/** Soft target for drawn tris (all visible systems). */
export const SOFT_TRI_CAP = 1_800_000;
/** Refuse / auto-scale above this. */
export const HARD_TRI_CAP = 3_500_000;

/** Playable defaults (revised after QC grind). */
export const PLAYABLE = Object.freeze({
  // Dense Kanzan pom-poms — many instances, compact clusters
  canopyCount: 12_000,
  clusterFlowers: 1,
  petalsPerFlower: 16,
  petalSegmentsU: 2,
  petalSegmentsV: 2,
  grassCount: 40_000,
  grassSpacingM: 0.09,
  grassBladeSegs: 2,
  groundMossCount: 10_000,
  barkMossMax: 6_000,
  fallingPetalCount: 2_000,
  fallingPetalSegU: 2,
  fallingPetalSegV: 3,
  barkVoxelM: 0.065,
  barkAttractors: 700,
  barkRootAttractors: 350,
  barkMaxIter: 160,
  barkRootIter: 110
});

export function estimatePetalTris(segU, segV) {
  return segU * segV * 2;
}

export function estimateClusterTris({
  flowers = PLAYABLE.clusterFlowers,
  petalsPerFlower = PLAYABLE.petalsPerFlower ?? 16,
  segU = PLAYABLE.petalSegmentsU,
  segV = PLAYABLE.petalSegmentsV,
  buds = 0,
  budSegU = 2,
  budSegV = 2,
  layers = 2
} = {}) {
  const petal = estimatePetalTris(segU, segV);
  const bud = estimatePetalTris(budSegU, budSegV);
  // Kanzan lite: layered petals, no stamen
  const layered = Math.round(petalsPerFlower + layers);
  return flowers * layered * petal + buds * bud;
}

export function estimateGrassTris(count, bladeSegs = PLAYABLE.grassBladeSegs) {
  return count * bladeSegs * 2;
}

export function estimateStrandTris(count, segs = 3) {
  return count * segs * 2;
}

/**
 * Estimate total scene triangles for a config.
 * @param {object} cfg
 */
export function estimateSceneTris(cfg = {}) {
  const c = { ...PLAYABLE, ...cfg };
  const cluster = estimateClusterTris({
    flowers: c.clusterFlowers,
    segU: c.petalSegmentsU,
    segV: c.petalSegmentsV
  });
  const canopy = c.canopyCount * cluster;
  const grass = estimateGrassTris(c.grassCount, c.grassBladeSegs);
  const moss =
    estimateStrandTris(c.groundMossCount, 3) + estimateStrandTris(c.barkMossMax, 3);
  const falling = c.fallingPetalCount * estimatePetalTris(c.fallingPetalSegU, c.fallingPetalSegV);
  const bark = c.barkTrisEstimate ?? 25_000;
  const terrain = 40 * 40 * 2; // 1 m quads
  const total = canopy + grass + moss + falling + bark + terrain;
  return {
    total,
    breakdown: { canopy, grass, moss, falling, bark, terrain, clusterPerInstance: cluster },
    softOk: total <= SOFT_TRI_CAP,
    hardOk: total <= HARD_TRI_CAP
  };
}

/**
 * Clamp a requested config down until under HARD_TRI_CAP (prefer under SOFT).
 * @param {object} requested
 */
export function clampToBudget(requested = {}) {
  let cfg = { ...PLAYABLE, ...requested };

  // Hard instance ceilings (CPU upload / update cost) — apply first
  cfg.grassCount = Math.min(cfg.grassCount, PLAYABLE.grassCount);
  cfg.groundMossCount = Math.min(cfg.groundMossCount, PLAYABLE.groundMossCount);
  cfg.barkMossMax = Math.min(cfg.barkMossMax, PLAYABLE.barkMossMax);
  cfg.fallingPetalCount = Math.min(cfg.fallingPetalCount, PLAYABLE.fallingPetalCount);
  cfg.canopyCount = Math.min(cfg.canopyCount, PLAYABLE.canopyCount);
  cfg.clusterFlowers = Math.min(cfg.clusterFlowers ?? PLAYABLE.clusterFlowers, PLAYABLE.clusterFlowers);
  cfg.petalSegmentsU = Math.min(cfg.petalSegmentsU ?? PLAYABLE.petalSegmentsU, PLAYABLE.petalSegmentsU);
  cfg.petalSegmentsV = Math.min(cfg.petalSegmentsV ?? PLAYABLE.petalSegmentsV, PLAYABLE.petalSegmentsV);
  cfg.grassBladeSegs = Math.min(cfg.grassBladeSegs ?? PLAYABLE.grassBladeSegs, PLAYABLE.grassBladeSegs);

  let est = estimateSceneTris(cfg);
  const steps = [
    () => {
      cfg.grassCount = Math.min(cfg.grassCount, 28_000);
      cfg.fallingPetalCount = Math.min(cfg.fallingPetalCount, 1500);
    },
    () => {
      cfg.canopyCount = Math.min(cfg.canopyCount, 10_000);
      cfg.grassCount = Math.min(cfg.grassCount, 22_000);
    },
    () => {
      cfg.canopyCount = Math.min(cfg.canopyCount, 8_000);
      cfg.grassCount = Math.min(cfg.grassCount, 16_000);
      cfg.groundMossCount = Math.min(cfg.groundMossCount, 6_000);
    },
    () => {
      cfg.canopyCount = Math.min(cfg.canopyCount, 6_000);
      cfg.grassCount = Math.min(cfg.grassCount, 12_000);
      cfg.fallingPetalCount = Math.min(cfg.fallingPetalCount, 900);
    }
  ];

  for (const step of steps) {
    if (est.softOk) break;
    step();
    est = estimateSceneTris(cfg);
  }

  while (!est.hardOk && cfg.canopyCount > 150) {
    cfg.canopyCount = Math.floor(cfg.canopyCount * 0.75);
    cfg.grassCount = Math.floor(cfg.grassCount * 0.85);
    est = estimateSceneTris(cfg);
  }

  return { config: cfg, estimate: est };
}

export function formatBudget(est) {
  const m = (n) => `${(n / 1e6).toFixed(2)}M`;
  const b = est.breakdown;
  return (
    `tris≈${m(est.total)} (soft ${m(SOFT_TRI_CAP)} / hard ${m(HARD_TRI_CAP)}) · ` +
    `canopy ${m(b.canopy)} · grass ${m(b.grass)} · moss ${m(b.moss)} · ` +
    `falling ${m(b.falling)} · cluster ${b.clusterPerInstance}`
  );
}
