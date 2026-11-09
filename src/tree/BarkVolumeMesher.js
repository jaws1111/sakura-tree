/**
 * Public bark pipeline API: skeleton → SDF volume → Marching Cubes mesh.
 * All lengths in metres (1 Three.js unit = 1 m).
 */

import * as THREE from 'three';
import { buildSpaceColonizationSkeleton } from './skeleton.js';
import { bakeMarchingCubes } from './mesher.js';
import { bakeHybrid, HYBRID_DEFAULTS } from './hybridMesher.js';
import { createBarkMaterial } from './barkMaterial.js';
import {
  TREE_HEIGHT_M,
  CROWN_RADIUS_M,
  Y_FORK_M,
  TRUNK_BASE_RADIUS_M,
  TRUNK_DBH_RADIUS_M,
  TWIG_MIN_RADIUS_M,
  BARK_GROOVE_AMP_M,
  SDF_VOXEL_TRUNK_M
} from '../units.js';

/** Default hero-tree bake params (quality-first playable). */
export const DEFAULT_BAKE_PARAMS = Object.freeze({
  /** 'hybrid' (v1.1: surface nets + swept tubes, single mesh) | 'mc' (v1.0: marching cubes + twig proxy cylinders) */
  mesher: 'hybrid',
  seed: 42,
  attractorCount: 700,
  rootAttractorCount: 350,
  stepPrimaryM: 0.2,
  stepTwigM: 0.085,
  stepRootM: 0.12,
  killRadiusM: 0.34,
  influenceRadiusM: 1.05,
  rootKillRadiusM: 0.28,
  rootInfluenceRadiusM: 0.9,
  maxIterations: 160,
  maxRootIterations: 110,
  includeRoots: true,
  /** Finer voxel → smoother SDF→MC (0.1 was visibly chunky). */
  voxelM: 0.065,
  nearestK: 10,
  includeBark: true,
  /** Lower = keep more MC detail after vertex clustering. */
  simplifyCellScale: 1.15,
  leaderCount: 6,
  /** Density of thin blossom-attachment shoots (1 = default). */
  twigDensity: 1,
  /** Fork multiplier on those thin shoots (2 = default ~2× branching). */
  twigBranchMult: 2,
  /** First crown fork height on trunk (m). Low ≈ bush, high ≈ tree. */
  forkYM: Y_FORK_M
});

/**
 * @typedef {object} BakeResult
 * @property {THREE.BufferGeometry} geometry
 * @property {THREE.MeshStandardMaterial} material
 * @property {THREE.Mesh} mesh
 * @property {object} stats
 * @property {import('./skeleton.js').Skeleton} skeleton
 */

export class BarkVolumeMesher {
  /**
   * @param {object} [defaults] merged into each build/bake call
   */
  constructor(defaults = {}) {
    this.defaults = { ...DEFAULT_BAKE_PARAMS, ...defaults };
    /** @type {import('./skeleton.js').Skeleton|null} */
    this.skeleton = null;
    /** @type {BakeResult|null} */
    this.lastBake = null;
  }

  /**
   * Stage A — space colonization graph with Leonardo radii + frames.
   * @param {object} [params]
   * @returns {import('./skeleton.js').Skeleton}
   */
  buildSkeleton(params = {}) {
    const p = { ...this.defaults, ...params };
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.skeleton = buildSpaceColonizationSkeleton({
      seed: p.seed,
      attractorCount: p.attractorCount,
      rootAttractorCount: p.rootAttractorCount,
      stepPrimaryM: p.stepPrimaryM,
      stepTwigM: p.stepTwigM,
      stepRootM: p.stepRootM,
      killRadiusM: p.killRadiusM,
      influenceRadiusM: p.influenceRadiusM,
      rootKillRadiusM: p.rootKillRadiusM,
      rootInfluenceRadiusM: p.rootInfluenceRadiusM,
      maxIterations: p.maxIterations,
      maxRootIterations: p.maxRootIterations,
      tropism: p.tropism,
      geotropism: p.geotropism,
      includeRoots: p.includeRoots !== false,
      leaderCount: p.leaderCount,
      twigDensity: p.twigDensity,
      twigBranchMult: p.twigBranchMult,
      forkYM: p.forkYM
    });
    const t1 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._lastSkeletonMs = t1 - t0;
    return this.skeleton;
  }

  /**
   * Stages B–C — evaluate wood SDF and extract BufferGeometry.
   * @param {import('./skeleton.js').Skeleton} [skeleton]
   * @param {object} [params]
   * @returns {BakeResult}
   */
  bakeMesh(skeleton = this.skeleton, params = {}) {
    if (!skeleton) {
      skeleton = this.buildSkeleton(params);
    }
    const p = { ...this.defaults, ...params };
    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    let geometry;
    let stats;
    if (p.mesher === 'mc') {
      // v1.0 path: marching cubes for thick wood only; thin wood needs buildTwigProxyGroup()
      delete skeleton.woodSurface;
      ({ geometry, stats } = bakeMarchingCubes(skeleton, {
        voxelM: p.voxelM ?? SDF_VOXEL_TRUNK_M * 2,
        nearestK: p.nearestK,
        includeBark: p.includeBark,
        simplifyCellScale: p.simplifyCellScale ?? 1.15
      }));
      stats.mesher = 'mc';
    } else {
      // v1.1 path: closed filleted surface nets for thick wood + swept tubes for thin wood, one mesh.
      // The GUI "voxel" slider keeps its meaning: surface-net cell ≈ 0.6 × voxel.
      const cellM = p.hybridCellM ?? Math.min(0.12, Math.max(0.03, (p.voxelM ?? 0.065) * 0.6));
      ({ geometry, stats } = bakeHybrid(skeleton, {
        cellM,
        decimateReduction: p.hybridDecimate ?? HYBRID_DEFAULTS.decimateReduction,
        capTubeBase: p.capTubeBase ?? false
      }));
    }

    const material = createBarkMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'BarkVolume';

    const t1 =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    stats.meshMs = t1 - t0;
    stats.skeletonMs = this._lastSkeletonMs ?? 0;
    stats.bakeMs = stats.meshMs + stats.skeletonMs;
    stats.edgeCount = skeleton.edges.length;
    stats.nodeCount = skeleton.nodes.length;
    stats.hero = {
      heightM: TREE_HEIGHT_M,
      crownRadiusM: CROWN_RADIUS_M,
      forkYM: Y_FORK_M,
      trunkBaseRadiusM: TRUNK_BASE_RADIUS_M,
      trunkDbhRadiusM: TRUNK_DBH_RADIUS_M,
      twigMinRadiusM: TWIG_MIN_RADIUS_M,
      barkGrooveAmpM: BARK_GROOVE_AMP_M
    };

    this.lastBake = { geometry, material, mesh, stats, skeleton };
    return this.lastBake;
  }

  /** Convenience: skeleton + bake in one call. */
  build(params = {}) {
    const skeleton = this.buildSkeleton(params);
    return this.bakeMesh(skeleton, params);
  }
}

export { createBarkMaterial, buildSpaceColonizationSkeleton };
