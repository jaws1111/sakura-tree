import * as THREE from 'three';
import {
  TREE_HEIGHT_M,
  TRUNK_BASE_RADIUS_M,
  TRUNK_DBH_RADIUS_M,
  Y_FORK_M,
  WIND_AMBIENT_MPS
} from '../units.js';
import {
  PLAYABLE,
  clampToBudget,
  formatBudget,
  estimateSceneTris
} from '../budget.js';
import { createTerrain, heightAt } from '../env/terrain.js';
import { createGrass } from '../env/grass.js';
import { createMoss, scatterMossOnMesh } from '../env/moss.js';
import { sampleWind } from '../env/wind.js';
import { FallingPetalDriftSystem } from '../petals/FallingPetalDriftSystem.js';
import { CanopyInstancer } from '../petals/CanopyInstancer.js';
import { BarkVolumeMesher } from '../tree/BarkVolumeMesher.js';
import { buildTwigProxyGroup } from '../tree/twigProxy.js';

/**
 * Orchestrator — clamps triangle budget before spawning heavy systems.
 */
export class ProceduralSakuraEngine {
  constructor(scene, renderer, options = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.clock = new THREE.Clock();
    this.wind = new THREE.Vector3(WIND_AMBIENT_MPS, 0, 0.25);
    this._windSample = new THREE.Vector3();

    const requested = {
      canopyCount: options.canopyCount ?? PLAYABLE.canopyCount,
      grassCount: options.grass?.maxCount ?? PLAYABLE.grassCount,
      groundMossCount: options.groundMossCount ?? PLAYABLE.groundMossCount,
      barkMossMax: options.barkMossMax ?? PLAYABLE.barkMossMax,
      fallingPetalCount: options.fallingPetalCount ?? PLAYABLE.fallingPetalCount,
      clusterFlowers: PLAYABLE.clusterFlowers,
      petalSegmentsU: PLAYABLE.petalSegmentsU,
      petalSegmentsV: PLAYABLE.petalSegmentsV,
      grassBladeSegs: PLAYABLE.grassBladeSegs
    };

    const { config, estimate } = clampToBudget(requested);
    this.budget = { config, estimate };
    if (typeof console !== 'undefined') {
      const tag = estimate.softOk ? 'OK' : estimate.hardOk ? 'WARN' : 'CLAMPED';
      console.info(`[Budget:${tag}] ${formatBudget(estimate)}`);
      if (!estimate.softOk) {
        console.warn(
          '[Budget] Requested scene too heavy — using clamped playable params:',
          config
        );
      }
    }

    this.barkMesher = new BarkVolumeMesher({
      voxelM: PLAYABLE.barkVoxelM,
      attractorCount: PLAYABLE.barkAttractors,
      rootAttractorCount: PLAYABLE.barkRootAttractors,
      maxIterations: PLAYABLE.barkMaxIter,
      maxRootIterations: PLAYABLE.barkRootIter,
      ...options.bark
    });
    this.skeleton = null;
    this.barkMesh = null;
    this.barkStats = null;
    this._grassOpts = {
      maxCount: config.grassCount,
      spacing: options.grass?.spacing ?? PLAYABLE.grassSpacingM,
      ...options.grass,
      maxCount: config.grassCount
    };
    this.autoBake = options.autoBake === true;
    this.deferredBake = options.deferredBake !== false;
    this.paused = Boolean(options.paused);

    this.initEnvironment(config);
    this.buildPlaceholderTree(config);
    this.canopy = new CanopyInstancer(this.scene, {
      count: config.canopyCount,
      quality: options.canopyQuality ?? 'lite'
    });
    /** @type {THREE.Group|null} */
    this.twigProxy = null;
    /** @type {null|((result: object) => void)} */
    this.onBarkBaked = null;
    // Same blossom mesh + material as the canopy (edge-fade shader)
    this.fallingPetals = new FallingPetalDriftSystem(this.scene, config.fallingPetalCount, {
      geometry: this.canopy.geoNear,
      material: this.canopy.material
    });
    this.canopy.material.userData.shared = true;
    this.fallingPetals.windAmbient.copy(this.wind);
    if (options.petalMode) this.fallingPetals.mode = options.petalMode;
    else this.fallingPetals.mode = 'CURL_NOISE'; // cheaper than BOIDS at scale

    if (this.autoBake) {
      this.bakeBark();
    } else if (this.deferredBake) {
      setTimeout(() => {
        try {
          this.bakeBark();
        } catch (err) {
          console.error('[BarkVolume] deferred bake failed', err);
        }
      }, 500);
    }
  }

  initEnvironment(config) {
    const hemi = new THREE.HemisphereLight(0xffe8f2, 0x4a3830, 0.72);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xfff2f8, 1.35);
    sun.position.set(15, 25, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    sun.shadow.bias = -0.0001;
    this.scene.add(sun);
    this.sun = sun;

    this.terrain = createTerrain();
    this.scene.add(this.terrain.group);
    this.ground = this.terrain.mesh;
    this.heightAt = heightAt;

    this.grass = createGrass(this._grassOpts);
    this.scene.add(this.grass.group);

    this.moss = createMoss({ maxGround: config.groundMossCount });
    this.scene.add(this.moss.group);

    this.scatterMossOnMesh = scatterMossOnMesh;
    this.sampleWind = sampleWind;
  }

  buildPlaceholderTree(config) {
    const boleHeight = Y_FORK_M;
    const geom = new THREE.CylinderGeometry(
      TRUNK_DBH_RADIUS_M,
      TRUNK_BASE_RADIUS_M,
      boleHeight,
      24,
      16
    );
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2d2426,
      roughness: 0.9,
      metalness: 0.05
    });
    const bole = new THREE.Mesh(geom, mat);
    const collarY = heightAt(0, 0);
    bole.position.y = collarY + boleHeight * 0.5;
    bole.castShadow = true;
    bole.receiveShadow = true;
    bole.name = 'PlaceholderBole';
    this.scene.add(bole);
    this.bole = bole;

    const barkMoss = scatterMossOnMesh(bole, {
      maxCount: config?.barkMossMax ?? PLAYABLE.barkMossMax
    });
    if (barkMoss) {
      this.scene.add(barkMoss);
      this.barkMoss = barkMoss;
    }
  }

  bakeBark(params = {}) {
    const result = this.barkMesher.build(params);
    this.skeleton = result.skeleton;
    this.barkStats = result.stats;

    if (this.bole) {
      this.scene.remove(this.bole);
      this.bole.geometry?.dispose();
      this.bole.material?.dispose();
      this.bole = null;
    }
    if (this.barkMoss) {
      this.scene.remove(this.barkMoss);
      this.barkMoss.geometry?.dispose();
      this.barkMoss.material?.dispose();
      this.barkMoss = null;
    }
    if (this.barkMesh) {
      this.scene.remove(this.barkMesh);
      this.barkMesh.geometry?.dispose();
      this.barkMesh.material?.dispose();
    }
    if (this.twigProxy) {
      this.scene.remove(this.twigProxy);
      this.twigProxy.userData?.dispose?.();
      this.twigProxy = null;
    }

    this.barkMesh = result.mesh;
    this.scene.add(this.barkMesh);
    this.barkVolume = result;

    // Thin twigs skipped by MC — add cheap tube proxies + rebind blossoms
    try {
      this.twigProxy = buildTwigProxyGroup(
        result.skeleton,
        result.stats?.voxelM ?? this.barkMesher.defaults.voxelM
      );
      if (this.twigProxy) this.scene.add(this.twigProxy);
    } catch (err) {
      console.warn('[TwigProxy] build failed', err);
    }
    try {
      this.canopy?.rebindToSkeleton?.(result.skeleton);
      this.syncFallingFromCanopy();
    } catch (err) {
      console.warn('[Canopy] rebind failed', err);
    }

    const moss = scatterMossOnMesh(this.barkMesh, {
      maxCount: this.budget?.config?.barkMossMax ?? PLAYABLE.barkMossMax
    });
    if (moss) {
      this.scene.add(moss);
      this.barkMoss = moss;
    }

    this.onBarkBaked?.(result);

    if (typeof console !== 'undefined') {
      const s = result.stats;
      const sk = result.skeleton;
      const live = estimateSceneTris({
        ...this.budget.config,
        barkTrisEstimate: s.triangles
      });
      const sim = s.simplify;
      const simMsg = sim
        ? ` · simplify ${(sim.reduction * 100).toFixed(0)}% (${sim.trianglesBefore}→${sim.trianglesAfter})`
        : '';
      console.info(
        `[BarkVolume] bake ${s.bakeMs?.toFixed?.(0) ?? '?'} ms ` +
          `(sk ${s.skeletonMs?.toFixed?.(0) ?? '?'} / mesh ${s.meshMs?.toFixed?.(0) ?? '?'}) · ` +
          `${s.triangles} tris · edges ${s.edgeCount} ` +
          `(roots ${sk.stats?.rootEdges ?? '?'} / shoots ${sk.stats?.shootEdges ?? '?'}) · ` +
          `voxel ${s.voxelM} m · y[${s.boundsMinM?.y?.toFixed(2)}, ${s.boundsMaxM?.y?.toFixed(2)}] m` +
          simMsg
      );
      console.info(`[Budget:live] ${formatBudget(live)}`);
    }

    return result.stats;
  }

  /**
   * Falling petals spawn from canopy thin-wood attach seats and match blossom size.
   */
  syncFallingFromCanopy() {
    const canopy = this.canopy;
    const fall = this.fallingPetals;
    if (!fall || !canopy) return;
    fall.setAttachPoints(canopy.attachPoints ?? null);
    fall.setPetalScale(canopy.sizeScale ?? 1);
    // Respawn airborne petals onto new seats so they originate from the tree
    for (let i = 0; i < fall.count; i++) {
      if (fall.settleAge[i] < 0) fall.resetParticle(i, false);
    }
    fall.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {THREE.Camera} [camera] Enables screen-space / distance LOD culling.
   */
  tick(camera) {
    const dt = this.clock.getDelta();
    const t = this.clock.getElapsedTime();
    if (this.paused) {
      void TREE_HEIGHT_M;
      return;
    }

    sampleWind(0, 2, 0, t, this._windSample);
    this.wind.copy(this._windSample);

    const windStrength = THREE.MathUtils.clamp(this.wind.length() / 5.0, 0.15, 1.0);
    this.canopy?.update(t, windStrength, camera);
    this.grass?.update(t, camera);
    this.moss?.update(t);

    if (this.fallingPetals) {
      this.fallingPetals.windAmbient.copy(this.wind);
      this.fallingPetals.update(dt, t);
    }
    void TREE_HEIGHT_M;
  }
}
