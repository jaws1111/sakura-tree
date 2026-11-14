import * as THREE from 'three';
import {
  TRUNK_BASE_RADIUS_M,
  TRUNK_DBH_RADIUS_M,
  WIND_AMBIENT_MPS
} from '../units.js';
import {
  PLAYABLE,
  clampToBudget,
  formatBudget,
  estimateSceneTris
} from '../budget.js';
import { createTerrain, heightAt, setLandscape } from '../env/terrain.js';
import { GroundMaps } from '../env/groundMaps.js';
import { createGrass } from '../env/grass.js';
import { createMoss, createBarkMoss } from '../env/moss.js';
import { Atmosphere } from '../env/atmosphere.js';
import { createCsmShadows } from '../env/csmShadows.js';
import { createRiver } from '../env/river.js';
import { createGardenProps } from '../env/gardenProps.js';
import { GROVE_DEFAULT_COUNT, GROVE_MAX, GROVE_SLOTS, groveSeed } from '../env/grove.js';
import { SWAY_U } from '../env/sceneUniforms.js';
import { sampleWind } from '../env/wind.js';
import { FallingPetalDriftSystem } from '../petals/FallingPetalDriftSystem.js';
import { CanopyInstancer } from '../petals/CanopyInstancer.js';
import { SakuraMaterialFactory } from '../petals/SakuraMaterialFactory.js';
import { BarkVolumeMesher } from '../tree/BarkVolumeMesher.js';
import { buildTwigProxyGroup } from '../tree/twigProxy.js';
import { deriveBakeParams, normalizeTreeSpec } from '../tree/treeSpec.js';

/**
 * Orchestrator — clamps triangle budget before spawning heavy systems.
 *
 * v1.2: owns the whole scene — meadow/hills/mountains, sky + time of day, wind sway, moss, falling-petal shower — and the
 * tree size model (`setTreeSpec`). Everything that depends on the tree's footprint is re-fitted in `#applyTreeBounds`.
 */
export class ProceduralSakuraEngine {
  constructor(scene, renderer, options = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.clock = typeof THREE.Timer === 'function' ? new THREE.Timer() : new THREE.Clock();
    if (typeof document !== 'undefined' && this.clock.connect) this.clock.connect(document);
    this.camera = options.camera ?? null;
    this.wind = new THREE.Vector3(WIND_AMBIENT_MPS, 0, 0.25);
    this._windSample = new THREE.Vector3();
    this._frozenT = 0;
    this.features = {
      csm: false,
      pmrem: false,
      workerBake: typeof Worker !== 'undefined',
      batchedMesh: true,
      reversedZ: Boolean(renderer?.capabilities?.reversedDepthBuffer),
      petalTransmission: true,
      grassCastShadow: true,
      threeVersion: THREE.REVISION,
      webgpuPetals: false
    };

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
        console.warn('[Budget] Requested scene too heavy — using clamped playable params:', config);
      }
    }

    /** Tree size & complexity — the single source of truth (see tree/treeSpec.js). */
    this.treeSpec = normalizeTreeSpec(options.tree);
    /** Options that pin individual bake parameters over the derived ones (QC / tests). */
    this.barkPins = { ...(options.bark ?? {}) };
    /** User-facing bake extras (not derived from size). */
    this.bakeExtras = {
      mesher: 'hybrid',
      seed: 42,
      twigBranchMult: 2,
      simplifyCellScale: 1.15,
      voxelScale: 1,
      /** 0 = buried roots, 1 = strong nebari / surface flare */
      rootEmergence: 0.35
    };
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
    this.barkMoss = null;
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
    /** @type {null|((spec: object) => void)} */
    this.onTreeSpecChanged = null;

    /** Companion grove: same treeSpec / bake extras, unique seeds + designed slots. */
    this.groveCount = THREE.MathUtils.clamp(
      options.groveCount ?? GROVE_DEFAULT_COUNT,
      0,
      GROVE_MAX
    );
    this.groveSeedSalt = 0;
    /** @type {Array<{ root: THREE.Group, mesh: THREE.Mesh, canopy: CanopyInstancer, barkMoss: object|null, fallingPetals: FallingPetalDriftSystem|null, seed: number, x: number, z: number, yaw: number }>} */
    this.grove = [];
    this._groveBuildId = 0;
    this._attachTmp = new THREE.Vector3();
    /** Total falling-petal pool across hero + companions (GUI global). */
    this.petalPoolTotal = config.fallingPetalCount;

    this.initEnvironment(config, options);
    this.buildPlaceholderTree(config);
    this.canopy = new CanopyInstancer(this.scene, {
      count: config.canopyCount,
      quality: options.canopyQuality ?? 'lite'
    });
    /** @type {THREE.Group|null} */
    this.twigProxy = null;
    /** @type {null|((result: object) => void)} */
    this.onBarkBaked = null;
    /** @type {null|((canopy: object) => void)} */
    this.onCanopyReady = null;

    // Falling petals share the blossom geometry; their material is a non-swaying twin of the canopy material
    this.fallingPetals = new FallingPetalDriftSystem(this.scene, config.fallingPetalCount, {
      geometry: this.canopy.geoNear,
      material: SakuraMaterialFactory.createFreeTwin(this.canopy.material)
    });
    this.fallingPetals.windAmbient.copy(this.wind);
    if (options.petalMode) this.fallingPetals.mode = options.petalMode;
    else this.fallingPetals.mode = 'CURL_NOISE'; // cheaper than BOIDS at scale
    // petals come to rest on top of the grass layer, not inside the soil
    this.fallingPetals.supportAt = () => 0.028 * (this.grass?.uniforms?.uHeightScale?.value ?? 1);
    this.fallingPetals.setCrown(this.treeSpec.heightM, this.treeSpec.crownRadiusM);

    // Prefer WebGPU compute for airborne petals when the browser exposes it
    this.fallingPetals.enableCompute?.().then((ok) => {
      this.features.webgpuPetals = Boolean(ok);
    });

    if (this.autoBake) {
      this.bakeBark();
    } else if (this.deferredBake) {
      setTimeout(() => {
        this.bakeBarkAsync().catch((err) => {
          globalThis.__SAKURA_TEL?.event('bake-deferred-fail', err);
          console.error('[BarkVolume] deferred bake failed', err);
        });
      }, 500);
    }
  }

  initEnvironment(config, options = {}) {
    const hemi = new THREE.HemisphereLight(0xffe8f2, 0x4a3830, 0.72);
    this.scene.add(hemi);
    this.hemi = hemi;

    let sun;
    let csm = null;
    if (this.camera) {
      csm = createCsmShadows({
        scene: this.scene,
        camera: this.camera,
        renderer: this.renderer,
        cascades: 3,
        shadowMapSize: 2048,
        maxFar: 160
      });
      sun = csm.sunProxy;
      this.features.csm = true;
    } else {
      sun = new THREE.DirectionalLight(0xfff2f8, 1.35);
      sun.position.set(15, 25, 10);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.bias = -0.0001;
      sun.shadow.normalBias = 0.02;
      this.scene.add(sun);
    }
    this.sun = sun;
    this.csm = csm;

    this.groundMaps = new GroundMaps({ seed: 7 });
    this.groundMaps.setCrownRadius(this.treeSpec.crownRadiusM);

    this.terrain = createTerrain({ maps: this.groundMaps });
    this.scene.add(this.terrain.group);
    this.ground = this.terrain.mesh;
    this.heightAt = heightAt;

    this.grass = createGrass({ ...this._grassOpts, maps: this.groundMaps });
    this.scene.add(this.grass.group);

    this.moss = createMoss({
      maps: this.groundMaps,
      maxCushions: config.groundMossCount,
      crownRadiusM: this.treeSpec.crownRadiusM
    });
    this.scene.add(this.moss.group);

    this.atmosphere = new Atmosphere(this.scene, this.renderer, { sun, hemi, csm });
    this.atmosphere.setTreeBounds(this.treeSpec.heightM, this.treeSpec.crownRadiusM);
    this.atmosphere.setPreset(options.time ?? 'day');
    this.features.pmrem = Boolean(this.atmosphere.pmrem);

    this.river = createRiver();
    this.scene.add(this.river.group);

    this.gardenProps = null;
    createGardenProps({ csm }).then((props) => {
      this.gardenProps = props;
      this.scene.add(props.group);
      this.features.gardenProps = true;
      this.syncShadows();
    });

    this.syncShadows();

    /** moss controls that are not part of the modules themselves */
    this.ecology = { groundMoss: 1, barkMoss: 0.8, barkMossThickness: 0.011, flowers: 1.05 };
    this.sampleWind = sampleWind;
    this.#syncSwayUniforms();
  }

  /**
   * Bind every MeshStandard/Physical material under the scene (and known roots)
   * for CSM cascade selection. Safe to call repeatedly — setupMaterial is idempotent.
   */
  syncShadows() {
    if (!this.csm) return;
    this.csm.bindObject(this.scene);
    // Explicit roots in case something was temporarily detached
    this.csm.bindObject(this.terrain?.group ?? this.terrain?.mesh);
    this.csm.bindObject(this.grass?.group);
    this.csm.bindObject(this.moss?.group);
    this.csm.bindObject(this.barkMoss?.group);
    this.csm.bindObject(this.barkMesh);
    this.csm.bindObject(this.river?.group);
    this.csm.bindObject(this.gardenProps?.group);
    this.csm.bindObject(this.twigProxy);
    this.csm.bindObject(this.bole);
    for (const c of this.grove) this.csm.bindObject(c.root);
  }

  /** @deprecated use syncShadows */
  #bindCsmMaterials() {
    this.syncShadows();
  }

  #syncSwayUniforms() {
    SWAY_U.uSwayTreeH.value = this.treeSpec.heightM;
    SWAY_U.uSwayCrownR.value = this.treeSpec.crownRadiusM;
    SWAY_U.uSwayForkY.value = this.skeleton?.forkYM ?? this.treeSpec.forkYM;
  }

  buildPlaceholderTree() {
    const boleHeight = this.treeSpec.forkYM;
    const k = this.treeSpec.heightM / 9;
    const geom = new THREE.CylinderGeometry(TRUNK_DBH_RADIUS_M * k, TRUNK_BASE_RADIUS_M * k, boleHeight, 24, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2d2426, roughness: 0.9, metalness: 0.05 });
    const bole = new THREE.Mesh(geom, mat);
    const collarY = heightAt(0, 0);
    bole.position.y = collarY + boleHeight * 0.5;
    bole.castShadow = true;
    bole.receiveShadow = true;
    bole.name = 'PlaceholderBole';
    this.scene.add(bole);
    this.bole = bole;
  }

  /**
   * Change tree size / crown / fork / complexity. Everything that depends on the footprint is re-fitted; by default the
   * tree is re-grown (a few hundred ms for a mature tree — see doc/environment_v1.2.md for the cost table).
   * @param {Partial<import('../tree/treeSpec.js').DEFAULT_TREE_SPEC>} patch
   * @param {{ bake?: boolean }} [opts]
   */
  setTreeSpec(patch = {}, { bake = true } = {}) {
    this.treeSpec = normalizeTreeSpec({ ...this.treeSpec, ...patch });
    this.#applyTreeBounds();
    if (bake) return this.bakeBark();
    return null;
  }

  #applyTreeBounds() {
    const { heightM: H, crownRadiusM: R, forkYM } = this.treeSpec;
    SWAY_U.uSwayTreeH.value = H;
    SWAY_U.uSwayCrownR.value = R;
    SWAY_U.uSwayForkY.value = forkYM;
    this.atmosphere?.setTreeBounds(H, R);
    this.fallingPetals?.setCrown(H, R);
    if (this.groundMaps && Math.abs(this.groundMaps.crownRadiusM - R) > 1e-3) {
      this.groundMaps.setCrownRadius(R);
      this.grass?.rebuild();
      this.moss?.setCrownRadius(R);
    }
    this.onTreeSpecChanged?.(this.treeSpec);
  }

  /** Bark parameters for the current spec: derived < pins (options.bark) < extras < explicit params. */
  resolveBakeParams(params = {}) {
    const d = deriveBakeParams(this.treeSpec);
    const e = this.bakeExtras;
    const base = {
      ...d,
      voxelM: d.voxelM * (e.voxelScale ?? 1),
      mesher: e.mesher,
      seed: e.seed,
      twigBranchMult: e.twigBranchMult,
      simplifyCellScale: e.simplifyCellScale,
      rootEmergence: e.rootEmergence ?? 0
    };
    return { ...base, ...this.barkPins, ...params };
  }

  /** Apply a finished bake result to the scene (sync or worker). */
  #applyBakeResult(result) {
    globalThis.__SAKURA_TEL?.event('bake-apply-start', {
      triangles: result?.stats?.triangles ?? null,
      nodes: result?.skeleton?.nodes?.length ?? null
    });
    this.skeleton = result.skeleton;
    this.barkStats = result.stats;

    // Unregister CSM bindings BEFORE dispose — stale shader-map entries break cascade
    // receives after the first rebuild (trunk/moss go black, ground loses tree shadow).
    if (this.barkMoss?.mesh?.material) this.csm?.unregisterMaterial?.(this.barkMoss.mesh.material);
    if (this.barkMesh?.material) this.csm?.unregisterMaterial?.(this.barkMesh.material);
    if (this.bole?.material) this.csm?.unregisterMaterial?.(this.bole.material);
    if (this.twigProxy) {
      this.twigProxy.traverse((o) => {
        if (o.isMesh || o.isInstancedMesh) this.csm?.unregisterMaterial?.(o.material);
      });
    }

    if (this.bole) {
      this.scene.remove(this.bole);
      this.bole.geometry?.dispose();
      this.bole.material?.dispose();
      this.bole = null;
    }
    if (this.barkMoss) {
      this.scene.remove(this.barkMoss.group);
      this.barkMoss.dispose();
      this.barkMoss = null;
    }
    if (this.barkMesh) {
      this.scene.remove(this.barkMesh);
      this.barkMesh.geometry?.dispose();
      this.barkMesh.material?.dispose();
      this.barkMesh.customDepthMaterial?.dispose?.();
    }
    if (this.twigProxy) {
      this.scene.remove(this.twigProxy);
      this.twigProxy.userData?.dispose?.();
      this.twigProxy = null;
    }

    this.barkMesh = result.mesh;
    this.barkMesh.castShadow = true;
    this.barkMesh.receiveShadow = true;
    this.scene.add(this.barkMesh);
    this.barkVolume = result;
    this.#syncSwayUniforms();
    if (this.csm && result.mesh?.material) this.csm.setupMaterial(result.mesh.material);

    // v1.0 (marching cubes) skips thin twigs — add cheap tube proxies. v1.1 hybrid already meshed them.
    if (result.stats?.mesher === 'mc') {
      try {
        this.twigProxy = buildTwigProxyGroup(
          result.skeleton,
          result.stats?.voxelM ?? this.barkMesher.defaults.voxelM
        );
        if (this.twigProxy) this.scene.add(this.twigProxy);
      } catch (err) {
        console.warn('[TwigProxy] build failed', err);
      }
    }
    try {
      this.canopy?.rebindToSkeleton?.(result.skeleton);
      this.syncFallingFromCanopy();
    } catch (err) {
      console.warn('[Canopy] rebind failed', err);
    }

    this.#buildBarkMoss(result);
    this.syncShadows();
    this.csm?.prune?.(this.scene);
    if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    this.onBarkBaked?.(result);
    globalThis.__SAKURA_TEL?.event('bake-apply-done', {
      triangles: result?.stats?.triangles ?? null,
      canopy: this.canopy?.placed ?? null
    });

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
      const workerTag = s.worker ? ' · worker' : '';
      console.info(
        `[BarkVolume] bake ${s.bakeMs?.toFixed?.(0) ?? '?'} ms` +
          workerTag +
          ` (sk ${s.skeletonMs?.toFixed?.(0) ?? '?'} / mesh ${s.meshMs?.toFixed?.(0) ?? '?'}) · ` +
          `${s.triangles} tris · edges ${s.edgeCount} ` +
          `(roots ${sk.stats?.rootEdges ?? '?'} / shoots ${sk.stats?.shootEdges ?? '?'}) · ` +
          `voxel ${s.voxelM} m · y[${s.boundsMinM?.y?.toFixed(2)}, ${s.boundsMaxM?.y?.toFixed(2)}] m` +
          simMsg
      );
      console.info(`[Budget:live] ${formatBudget(live)}`);
    }

    return result.stats;
  }

  bakeBark(params = {}) {
    const result = this.barkMesher.build(this.resolveBakeParams(params));
    const stats = this.#applyBakeResult(result);
    // Sync companions without awaiting — callers that need both should use bakeBarkAsync
    this.#rebuildGrove().catch((err) => console.warn('[Grove] rebuild failed', err));
    return stats;
  }

  /** Worker bake when available (Architecture §3.3). */
  async bakeBarkAsync(params = {}) {
    const result = await this.barkMesher.buildAsync(this.resolveBakeParams(params));
    const stats = this.#applyBakeResult(result);
    await this.#rebuildGrove();
    return stats;
  }

  /**
   * Plant N companion trees (0–3) using the same size/mesher settings as the hero,
   * each with a different seed. Positions use the designed grove slots.
   * @param {number} n
   */
  async setGroveCount(n) {
    this.groveCount = THREE.MathUtils.clamp(Math.floor(n), 0, GROVE_MAX);
    await this.#rebuildGrove();
    return this.groveCount;
  }

  /** Keep slot positions; roll new companion seeds from the current hero seed. */
  async reseedGrove() {
    this.groveSeedSalt = 1 + Math.floor(Math.random() * 900);
    await this.#rebuildGrove();
  }

  /** Hero + companion canopies (shared blossom settings). */
  canopies() {
    return [this.canopy, ...this.grove.map((c) => c.canopy)].filter(Boolean);
  }

  /** Hero + companion falling-petal systems (inseparable from each tree). */
  petalSystems() {
    return [this.fallingPetals, ...this.grove.map((c) => c.fallingPetals)].filter(Boolean);
  }

  #worldAttachPoints(canopy, root) {
    const local = canopy?.attachPoints;
    if (!local || local.length < 3) return null;
    const out = new Float32Array(local.length);
    root.updateMatrixWorld(true);
    const m = root.matrixWorld;
    const v = this._attachTmp;
    for (let i = 0; i < local.length; i += 3) {
      v.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(m);
      out[i] = v.x;
      out[i + 1] = v.y;
      out[i + 2] = v.z;
    }
    return out;
  }

  #copyPetalKnobs(from, to) {
    if (!from || !to) return;
    for (const k of [
      'enabled',
      'emissionRate',
      'fallScale',
      'windGain',
      'flutter',
      'swirl',
      'turbulence',
      'groundLifeMin',
      'groundLifeMax',
      'mode',
      'lodFarM'
    ]) {
      if (from[k] != null) to[k] = from[k];
    }
  }

  #makeTreePetals(canopy, root, poolCount) {
    const fall = new FallingPetalDriftSystem(this.scene, poolCount, {
      geometry: canopy.geoNear,
      material: SakuraMaterialFactory.createFreeTwin(canopy.material)
    });
    fall.mode = this.fallingPetals?.mode ?? 'CURL_NOISE';
    fall.supportAt = () => 0.028 * (this.grass?.uniforms?.uHeightScale?.value ?? 1);
    this.#copyPetalKnobs(this.fallingPetals, fall);
    // Scale emission with pool so companions aren't denser than the hero
    const heroPool = this.fallingPetals?.count || poolCount;
    const heroRate = this.fallingPetals?.emissionRate ?? 14;
    fall.emissionRate = Math.max(2, heroRate * (poolCount / Math.max(1, heroPool)));
    fall.setAttachPoints(this.#worldAttachPoints(canopy, root));
    fall.setPetalScale(canopy.sizeScale ?? 1);
    fall.setCrown(this.treeSpec.heightM, this.treeSpec.crownRadiusM);
    fall.windAmbient.copy(this.wind);
    fall.reseed({ clearGround: false });
    fall.prewarm(Math.min(fall.count * 0.45, fall.emissionRate * 8));
    return fall;
  }

  #disposeCompanion(c) {
    if (!c) return;
    this.scene.remove(c.root);
    if (c.fallingPetals) {
      this.scene.remove(c.fallingPetals.instancedMesh);
      c.fallingPetals.dispose?.();
      c.fallingPetals = null;
    }
    if (c.canopy) {
      this.csm?.unregisterMaterial?.(c.canopy.material);
      c.canopy.dispose?.();
    }
    if (c.barkMoss) {
      this.csm?.unregisterMaterial?.(c.barkMoss.mesh?.material);
      c.barkMoss.dispose?.();
    }
    if (c.mesh) {
      this.csm?.unregisterMaterial?.(c.mesh.material);
      c.mesh.geometry?.dispose?.();
      c.mesh.material?.dispose?.();
      c.mesh.customDepthMaterial?.dispose?.();
    }
  }

  #clearGrove() {
    for (const c of this.grove) this.#disposeCompanion(c);
    this.grove.length = 0;
  }

  async #bakeCompanion({ seed, x, z, yaw = 0 }) {
    const params = this.resolveBakeParams({ seed });
    // Slightly coarser mesh keeps the grove affordable next to the hero tree
    if (Number.isFinite(params.voxelM)) params.voxelM *= 1.15;
    const result = await this.barkMesher.buildAsync(params);
    const root = new THREE.Group();
    root.name = `groveTree-${seed}`;
    root.position.set(x, heightAt(x, z), z);
    root.rotation.y = yaw;

    const mesh = result.mesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    if (this.csm && mesh.material) this.csm.setupMaterial(mesh.material);

    const canopyCount = Math.max(
      120,
      Math.floor((this.canopy?.count ?? this.budget?.config?.canopyCount ?? 6000) * 0.32)
    );
    const canopy = new CanopyInstancer(root, {
      count: canopyCount,
      seed,
      quality: 'lite',
      sizeScale: this.canopy?.sizeScale ?? 1,
      peduncleScale: this.canopy?.peduncleScale ?? 1
    });
    // Match hero blossom look (edgeFade is a GUI 0–1 mapping — skip raw SDF copy)
    if (this.canopy) {
      canopy.setRenderOptions?.({
        castShadow: this.canopy.castShadow,
        receiveShadow: this.canopy.receiveShadow,
        primaryColor: this.canopy.material?.userData?.uniforms?.uColorPrimary?.value,
        centerColor: this.canopy.material?.userData?.uniforms?.uColorCenter?.value,
        emissiveIntensity: this.canopy.material?.emissiveIntensity,
        opacity: this.canopy.material?.opacity
      });
    }
    try {
      canopy.rebindToSkeleton?.(result.skeleton);
    } catch (err) {
      console.warn('[Grove] canopy rebind failed', err);
    }

    let barkMoss = null;
    try {
      const limit = result.stats?.barkIndexCount;
      barkMoss = createBarkMoss(mesh, {
        indexLimit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
        treeHeight: this.treeSpec.heightM,
        forkY: result.skeleton?.forkYM ?? this.treeSpec.forkYM,
        coverage: (this.ecology?.barkMoss ?? 0.8) * 0.85,
        thickness: this.ecology?.barkMossThickness ?? 0.011,
        maxTriangles: Math.floor((this.budget?.config?.barkMossMax ?? PLAYABLE.barkMossMax) * 0.35)
      });
      root.add(barkMoss.group);
    } catch (err) {
      console.warn('[Grove] bark moss failed', err);
    }

    this.scene.add(root);

    // Tree + falling petals are inseparable
    const total = this.petalPoolTotal ?? this.fallingPetals?.count ?? 8000;
    const nComp = Math.max(1, this.groveCount);
    const heroShare = Math.max(200, Math.floor(total * 0.55));
    const petalPool = Math.max(200, Math.floor((total - heroShare) / nComp));
    const fallingPetals = this.#makeTreePetals(canopy, root, petalPool);
    // The twin shares this canopy's uniforms, so a look can restamp the petals now.
    this.onCanopyReady?.(canopy);

    return { root, mesh, canopy, barkMoss, fallingPetals, seed, x, z, yaw, skeleton: result.skeleton };
  }

  async #rebuildGrove() {
    const id = ++this._groveBuildId;
    this.#clearGrove();
    const n = THREE.MathUtils.clamp(this.groveCount | 0, 0, GROVE_MAX);
    const base = this.bakeExtras?.seed ?? 42;
    for (let i = 0; i < n; i++) {
      if (id !== this._groveBuildId) return;
      const slot = GROVE_SLOTS[i];
      if (!slot) break;
      try {
        const companion = await this.#bakeCompanion({
          seed: groveSeed(base, i, this.groveSeedSalt),
          x: slot.x,
          z: slot.z,
          yaw: slot.yaw
        });
        if (id !== this._groveBuildId) {
          this.#disposeCompanion(companion);
          return;
        }
        this.grove.push(companion);
      } catch (err) {
        console.warn(`[Grove] companion ${i} bake failed`, err);
      }
    }
    // Rebalance hero/companion petal pools now that grove size is known
    if (this.petalPoolTotal != null) {
      const total = this.petalPoolTotal;
      const n = this.grove.length;
      const heroShare = n ? Math.max(200, Math.floor(total * 0.55)) : total;
      const each = n ? Math.max(200, Math.floor((total - heroShare) / n)) : 0;
      this.fallingPetals?.setCount?.(heroShare);
      for (const c of this.grove) c.fallingPetals?.setCount?.(each);
      this.syncFallingFromCanopy();
    }
    this.syncShadows();
    if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
  }

  #buildBarkMoss(result) {
    try {
      // hybrid mesh = thick wood first (surface nets), then thin tubes; only the thick part can hold moss
      const limit = result.stats?.barkIndexCount;
      this.barkMoss = createBarkMoss(this.barkMesh, {
        indexLimit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
        treeHeight: this.treeSpec.heightM,
        forkY: result.skeleton?.forkYM ?? this.treeSpec.forkYM,
        coverage: this.ecology.barkMoss,
        thickness: this.ecology.barkMossThickness,
        maxTriangles: this.budget?.config?.barkMossMax ?? PLAYABLE.barkMossMax
      });
      this.scene.add(this.barkMoss.group);
    } catch (err) {
      console.warn('[BarkMoss] build failed', err);
    }
  }

  /**
   * Re-shape the landscape (meadow swell, hills, mountains, range direction). The collar stays flat at y = 0, so the tree
   * does not move; mesh, ecology maps, grass and moss are re-derived from the new height field.
   * @param {{ meadowScale?: number, hillScale?: number, mountainScale?: number, mountainAzimuth?: number }} patch
   */
  setLandscapeParams(patch = {}) {
    setLandscape(patch);
    this.terrain?.refresh();
    this.groundMaps?.rebuild();
    this.grass?.rebuild();
    this.moss?.rebuild();
    this.river?.refresh?.();
    this.gardenProps?.refresh?.();
    for (const c of this.grove) {
      c.root.position.y = heightAt(c.x, c.z);
    }
    this.onLandscapeChanged?.();
  }

  /** Ground moss: terrain carpet (shader) + 3-D cushions & sporophytes. 0 = none … 1 = default … 1.6 = lush. */
  setGroundMoss(c) {
    this.ecology.groundMoss = c;
    if (this.terrain?.uniforms?.uMossCover) this.terrain.uniforms.uMossCover.value = c;
    this.moss?.setCoverage(c);
  }

  /** Bark moss: coverage rebuilds the shell geometry; thickness is a live uniform. */
  setBarkMoss({ coverage, thickness } = {}) {
    if (thickness != null) {
      this.ecology.barkMossThickness = thickness;
      this.barkMoss?.setThickness(thickness);
      for (const c of this.grove) c.barkMoss?.setThickness?.(thickness);
    }
    if (coverage != null) {
      this.ecology.barkMoss = coverage;
      this.barkMoss?.setCoverage(coverage);
      for (const c of this.grove) c.barkMoss?.setCoverage?.(coverage * 0.85);
    }
  }

  /**
   * Global canopy count — hero gets `n`, companions get ~32% each (same blossom settings).
   * @param {number} n
   */
  setGlobalCanopyCount(n) {
    const applied = this.canopy?.setCount?.(n);
    if (this.budget?.config && applied != null) this.budget.config.canopyCount = applied;
    const each = Math.max(120, Math.floor((applied ?? n) * 0.32));
    for (const c of this.grove) c.canopy?.setCount?.(each);
    this.syncFallingFromCanopy();
    return applied ?? n;
  }

  /** Global blossom size / peduncle — applied to every tree. */
  setGlobalBlossomSize(s) {
    for (const c of this.canopies()) c.setSize?.(s);
    this.syncFallingFromCanopy();
  }

  setGlobalPeduncleScale(s) {
    for (const c of this.canopies()) c.setPeduncleScale?.(s);
    this.syncFallingFromCanopy();
  }

  /** Global blossom render look — every canopy. */
  applyCanopyRenderOptions(opts) {
    for (const c of this.canopies()) c.setRenderOptions?.(opts);
  }

  /**
   * Total falling-petal pool across the grove. Hero keeps ~55%; companions share the rest.
   * @param {number} total
   */
  setGlobalPetalCount(total) {
    this.petalPoolTotal = total;
    const n = this.grove.length;
    const heroShare = n ? Math.max(200, Math.floor(total * 0.55)) : total;
    const each = n ? Math.max(200, Math.floor((total - heroShare) / n)) : 0;
    this.fallingPetals?.setCount?.(heroShare);
    if (this.budget?.config) this.budget.config.fallingPetalCount = total;
    for (const c of this.grove) c.fallingPetals?.setCount?.(each);
    // Keep companion emission proportional to hero after resize
    const heroRate = this.fallingPetals?.emissionRate ?? 14;
    for (const c of this.grove) {
      if (!c.fallingPetals) continue;
      c.fallingPetals.emissionRate = Math.max(
        2,
        heroRate * (c.fallingPetals.count / Math.max(1, this.fallingPetals?.count || heroShare))
      );
    }
    this.syncFallingFromCanopy();
    return total;
  }

  /** Broadcast falling-petal knobs to every tree shower. */
  applyPetalSettings(patch = {}) {
    for (const fall of this.petalSystems()) {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && k in fall) fall[k] = v;
      }
    }
  }

  /** Falling petals spawn from each tree's blossom seats (world space). */
  syncFallingFromCanopy() {
    const H = this.treeSpec.heightM;
    const R = this.treeSpec.crownRadiusM;
    const syncOne = (fall, canopy, root = null) => {
      if (!fall || !canopy) return;
      const pts = root ? this.#worldAttachPoints(canopy, root) : canopy.attachPoints ?? null;
      fall.setAttachPoints(pts);
      fall.setPetalScale(canopy.sizeScale ?? 1);
      fall.setCrown(H, R);
      fall.reseed({ clearGround: false });
      fall.prewarm(Math.min(fall.count * 0.5, fall.emissionRate * 8));
      if (fall.instancedMesh) fall.instancedMesh.instanceMatrix.needsUpdate = true;
    };
    syncOne(this.fallingPetals, this.canopy, null);
    for (const c of this.grove) syncOne(c.fallingPetals, c.canopy, c.root);
  }

  /**
   * @param {THREE.Camera} [camera] Enables screen-space / distance LOD culling.
   */
  tick(camera) {
    if (typeof this.clock.update === 'function') this.clock.update();
    const rawDt = this.clock.getDelta();
    const dt = Math.min(typeof rawDt === 'number' ? rawDt : 0.016, 0.1);
    if (this.paused) {
      // frozen simulation, but the camera-dependent parts (sky centring, grass / moss LOD) still follow the view
      this.atmosphere?.update(0, camera, this._frozenT);
      this.grass?.update(this._frozenT, camera);
      this.moss?.update(this._frozenT, camera);
      this.csm?.update?.();
      return;
    }
    const t =
      typeof this.clock.getElapsed === 'function' ? this.clock.getElapsed() : this.clock.elapsedTime;
    this._frozenT = t;

    sampleWind(0, 2, 0, t, this._windSample);
    this.wind.copy(this._windSample);
    SWAY_U.uSwayTime.value = t;

    const windStrength = THREE.MathUtils.clamp(this.wind.length() / 5.0, 0.15, 1.0);
    this.atmosphere?.update(dt, camera, t);
    this.canopy?.update(t, windStrength, camera);
    for (const c of this.grove) {
      c.canopy?.update(t, windStrength, camera);
      c.barkMoss?.update?.(t);
    }
    this.grass?.update(t, camera);
    this.moss?.update(t, camera);
    this.barkMoss?.update(t);

    for (const fall of this.petalSystems()) {
      fall.windAmbient.copy(this.wind);
      fall.update(dt, t, camera);
    }
  }
}
