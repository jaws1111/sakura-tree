import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CAMERA_EYE_M, TREE_HEIGHT_M } from './units.js';
import { heightAt } from './env/terrain.js';
import { swayOffset } from './env/windSway.js';
import { ProceduralSakuraEngine } from './engine/ProceduralSakuraEngine.js';
import { DebugOverlay } from './debug/DebugOverlay.js';
import { mountAnalysisGui } from './debug/AnalysisGui.js';
import { createPerfHud } from './debug/PerfHud.js';
import { createCinematicCamera, CINEMATIC_MODE_IDS } from './debug/CinematicCamera.js';
import { createPostFX } from './debug/PostFX.js';
import { applyRenderLook, bindRenderLooks, parseRenderLookId } from './debug/renderLooks.js';
import { createTelemetry } from './debug/telemetry.js';
import { SIZE_PRESETS } from './tree/treeSpec.js';
import { createSceneComposer, DEFAULT_SCENE_PRESET_ID } from './scene/SceneComposer.js';

const canvas = document.querySelector('#app');
const qcParamsEarly = new URLSearchParams(location.search);
const qcModeEarly = qcParamsEarly.get('qc') === '1';
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: qcModeEarly,
  // Reversed-Z for the 12 km far plane (EXT_clip_control when available)
  reversedDepthBuffer: true
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// r187+: PCFSoftShadowMap removed — PCF is the soft filtered path
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// exposure is driven per frame by the Atmosphere (time of day × the user's exposure bias)
renderer.toneMappingExposure = 1.0;

// No scene.fog: the terrain / grass shaders do their own height-dependent haze (fog is applied after tone mapping
// in three, which would never match the sky). scene.background is owned by the Atmosphere.
const scene = new THREE.Scene();

// far = 12 km: the terrain reaches 6 km and the sky dome 9 km
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 12000);
camera.position.set(2.8, CAMERA_EYE_M + 1.35, 15.8);
camera.lookAt(1.2, TREE_HEIGHT_M * 0.38, -1.0);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, TREE_HEIGHT_M * 0.4, 0);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 1.5;
controls.maxDistance = 160;
controls.enableDamping = true;

const cal = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x88aadd, roughness: 0.35 })
);
cal.name = 'refCube';
cal.castShadow = true;
cal.receiveShadow = true;
scene.add(cal);

const human = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.18, 1.34, 4, 8),
  new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.85 })
);
human.name = 'refHuman';
human.castShadow = true;
human.receiveShadow = true;
scene.add(human);
function placeReferences() {
  // Scale refs tucked past the left flank stones — out of the approach path
  cal.position.set(-8.2, heightAt(-8.2, 8.4) + 0.5, 8.4);
  human.position.set(-9.0, heightAt(-9.0, 9.2) + 0.85, 9.2);
}
placeReferences();

const hud = document.querySelector('#hud');
const qcMode = qcModeEarly;
const refs = { cal, human };
const perfHud = createPerfHud({ visible: !qcMode });
const cinema = createCinematicCamera({
  camera,
  controls,
  getTreeSpec: () => engine?.treeSpec
});
const postFX = createPostFX({
  renderer,
  scene,
  camera,
  getSunDir: () => engine?.atmosphere?.sunDir
});
// QC screenshots stay unfiltered for stable luma checks
if (qcMode) postFX.setEnabled(false);

const overlay = new DebugOverlay(scene);

const tel = createTelemetry({
  renderer,
  canvas,
  getEngine: () => engine ?? null,
  getPerf: () => perfHud.snapshot
});
window.__SAKURA_TEL = tel;

/** Camera presets scale with the tree, so a bonsai and an ancient tree are both framed sensibly. */
function cameraPresets() {
  const H = engine?.treeSpec?.heightM ?? TREE_HEIGHT_M;
  return {
    // Elevated approach: hero center, left grove depth, creek + torii on the right
    hero: { p: [0.32 * H, CAMERA_EYE_M + 0.15 * H, 1.72 * H], t: [0.12 * H, 0.34 * H, -0.1 * H] },
    trunk: { p: [0.36 * H, 0.2 * H, 0.5 * H], t: [0, 0.155 * H, 0] },
    roots: { p: [0.31 * H, 0.044 * H, 0.4 * H], t: [0, -0.044 * H, 0] },
    top: { p: [0.02 * H, 1.8 * H, 0.02 * H], t: [0, 0.44 * H, 0] },
    wire: { p: [0.2 * H, 0.27 * H, 0.27 * H], t: [0, 0.22 * H, 0] },
    // low eye-level on the hilltop, looking out over the valleys toward the higher mountain range
    horizon: { p: [0.6 * H, CAMERA_EYE_M + 0.1, 1.0 * H], t: [-0.15 * H, 0.24 * H, -2.4 * H] },
    // standing under the crown looking up
    under: { p: [0.28 * H, CAMERA_EYE_M, 0.28 * H], t: [0, 0.62 * H, 0] }
  };
}

function setCameraPreset(name) {
  if (cinema.enabled) cinema.setEnabled(false);
  const c = cameraPresets()[name] || cameraPresets().hero;
  camera.position.set(...c.p);
  camera.fov = 45;
  camera.near = 0.1;
  camera.updateProjectionMatrix();
  controls.target.set(...c.t);
  controls.update();
  gui?.syncCinema?.();
}

window.__SAKURA_QC = {
  ready: false,
  booting: true,
  error: null,
  engine: null,
  getSnapshot() {
    const eng = window.__SAKURA_QC.engine;
    if (!eng) {
      return { ready: false, booting: window.__SAKURA_QC.booting, error: window.__SAKURA_QC.error };
    }
    const info = renderer.info;
    const sk = eng.skeleton;
    const bark = eng.barkStats;
    return {
      ready: true,
      bakeDone: Boolean(eng.barkMesh),
      barkTris: bark?.triangles ?? null,
      barkVoxelM: bark?.voxelM ?? null,
      barkBoundsY: bark?.boundsMinM ? [bark.boundsMinM.y, bark.boundsMaxM.y] : null,
      rootEdges: sk?.stats?.rootEdges ?? null,
      shootEdges: sk?.stats?.shootEdges ?? null,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      perf: perfHud.snapshot,
      hasCanopy: Boolean(eng.canopy?.meshNear || eng.canopy?.mesh),
      hasGrass: Boolean(eng.grass),
      hasMoss: Boolean(eng.moss),
      hasFallingPetals: Boolean(eng.fallingPetals),
      hasTerrain: Boolean(eng.terrain),
      hasAtmosphere: Boolean(eng.atmosphere),
      canopyCount: eng.canopy?.count ?? null,
      fallingCount: eng.fallingPetals?.count ?? null,
      petals: eng.fallingPetals?.stats?.() ?? null,
      time: eng.atmosphere
        ? { hours: eng.atmosphere.hours, clock: eng.atmosphere.clockLabel, period: eng.atmosphere.periodLabel }
        : null,
      treeSpec: eng.treeSpec ?? null,
      skeletonSize: sk ? { heightM: sk.heightM, crownRadiusM: sk.crownRadiusM } : null,
      mossCushions: eng.moss?.groundCount ?? null,
      sporophytes: eng.moss?.sporeCount ?? null,
      barkMossTris: eng.barkMoss?.triangles ?? null,
      budget: eng.budget?.estimate ?? null,
      features: eng.features ?? null,
      fallingCompute: eng.fallingPetals?.computeBackend ?? null,
      camera: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z
      }
    };
  },
  setCamera(x, y, z, tx = 0, ty = (engine?.treeSpec?.heightM ?? TREE_HEIGHT_M) * 0.4, tz = 0) {
    camera.position.set(x, y, z);
    controls.target.set(tx, ty, tz);
    controls.update();
  },
  setCameraPreset,
  cinema,
  setCinematic(on, mode) {
    cinema.setEnabled(on);
    if (mode) cinema.setMode(mode);
    return cinema.snapshot();
  },
  /** CPU mirror of the shader sway at a world point (test hook). */
  swayAt(x, y, z, t = engine?.clock?.elapsedTime ?? 0) {
    const o = swayOffset(x, y, z, t);
    return { x: o.x, y: o.y, z: o.z, len: Math.hypot(o.x, o.y, o.z) };
  },
  setTime(hours) {
    engine?.atmosphere?.setTime(hours);
  },
  setPreset(name) {
    engine?.atmosphere?.setPreset(name);
  },
  gradeEnabled() {
    return Boolean(postFX.grade?.enabled);
  }
};

function syncDebugFromEngine(eng) {
  overlay.syncSkeleton(eng?.skeleton ?? null);
  overlay.syncBarkMesh(eng?.barkMesh ?? null);
  overlay.apply(eng, refs);
}

let engine;
let gui = null;
try {
  const tree = SIZE_PRESETS[qcParamsEarly.get('tree')] ?? undefined;
  engine = new ProceduralSakuraEngine(scene, renderer, {
    camera,
    deferredBake: !qcMode && qcParamsEarly.get('nobake') !== '1',
    autoBake: false,
    paused: qcMode,
    bark: qcMode ? { voxelM: 0.22, attractorCount: 220, maxIterations: 55 } : undefined,
    grass: qcMode ? { maxCount: 8_000, spacing: 0.18 } : undefined,
    canopyCount: qcMode ? 400 : undefined,
    fallingPetalCount: qcMode ? 400 : undefined,
    canopyQuality: qcMode ? 'lite' : 'lite',
    petalMode: 'CURL_NOISE',
    time: qcParamsEarly.get('time') ?? 'day',
    tree
  });
  if (!qcMode) {
    const looks = bindRenderLooks({
      postFX,
      getAtmosphere: () => engine.atmosphere,
      getCanopies: () => engine.canopies()
    });
    engine.onCanopyReady = looks.restampCanopy;
    applyRenderLook('photoreal');
  }
  // Prefer async worker bake for interactive GUI rebuilds
  if (!qcMode && typeof engine.bakeBarkAsync === 'function') {
    const _bakeSync = engine.bakeBark.bind(engine);
    engine.bakeBark = (params) => {
      // Keep sync API for tests/QC; schedule async when already baked once
      if (!engine.barkMesh) return _bakeSync(params);
      engine.bakeBarkAsync(params).catch((err) => {
        console.error(err);
        _bakeSync(params);
      });
      return engine.barkStats;
    };
  }
  engine.onLandscapeChanged = () => {
    placeReferences();
    engine.sceneComposer?.refreshHeights?.();
  };
  // Ref cube / human live outside the engine — bind them into CSM after engine lights exist
  engine.syncShadows?.();

  // Data-driven garden (bezier river/paths + props). Hides legacy static dressing.
  const sceneComposer = createSceneComposer({
    scene,
    camera,
    domElement: canvas,
    orbitControls: controls,
    csm: engine.csm,
    engine,
    renderer
  });
  engine.sceneComposer = sceneComposer;
  engine.river.group.visible = false;
  // When async legacy props arrive, keep them hidden (composer owns layout)
  Promise.resolve().then(async () => {
    for (let i = 0; i < 40 && !engine.gardenProps; i++) await new Promise((r) => setTimeout(r, 50));
    if (engine.gardenProps?.group) engine.gardenProps.group.visible = false;
    await sceneComposer.loadPreset(DEFAULT_SCENE_PRESET_ID);
    engine.syncShadows?.();
  });

  window.__SAKURA_QC.engine = engine;
  window.__SAKURA_QC.sceneComposer = sceneComposer;
  window.__SAKURA_QC.ready = true;
  window.__SAKURA_QC.booting = false;
  window.__SAKURA_QC.setPaused = (v) => {
    if (engine) engine.paused = Boolean(v);
  };
  const camParam = qcParamsEarly.get('cam');
  if (camParam && cameraPresets()[camParam]) setCameraPreset(camParam);

  engine.onBarkBaked = () => {
    syncDebugFromEngine(engine);
    gui?.updateStats?.();
  };

  if (!qcMode) {
    gui = mountAnalysisGui({
      overlay,
      engine,
      refs,
      renderer,
      sceneComposer,
      actions: {
        /** Re-grow the tree. `patch` = tree spec fields, `extras` = bake extras (mesher, seed, …). */
        rebuildTree: ({ patch, extras } = {}) => {
          const prevH = engine.treeSpec.heightM;
          if (hud) hud.textContent = 'Growing tree…';
          // yield so the HUD paints; bake runs on a worker when available
          setTimeout(async () => {
            try {
              if (extras) Object.assign(engine.bakeExtras, extras);
              if (patch) engine.setTreeSpec(patch, { bake: false });
              await engine.bakeBarkAsync();
              syncDebugFromEngine(engine);
              if (Math.abs(engine.treeSpec.heightM - prevH) > 0.05 * prevH) setCameraPreset('hero');
              gui?.updateStats?.();
            } catch (err) {
              console.error(err);
              if (hud) hud.textContent = `Bake failed: ${err?.message || err}`;
            }
          }, 30);
        },
        camera: setCameraPreset,
        cinema,
        postFX,
        preset: (name) => {
          overlay.applyPreset(name, engine, refs);
          if (name === 'roots') setCameraPreset('roots');
          if (name === 'mesh') setCameraPreset('wire');
          if (name === 'skeleton') setCameraPreset('hero');
          gui?.updateStats?.();
        },
        getStats: () => {
          const bark = engine.barkStats;
          const sk = engine.skeleton;
          const sim = bark?.simplify;
          return {
            nodes: sk?.nodes?.length,
            edges: sk?.edges?.length,
            shootEdges: sk?.stats?.shootEdges,
            twigEdges: sk?.stats?.twigEdges,
            rootEdges: sk?.stats?.rootEdges,
            barkTris: bark?.triangles,
            voxelM: bark?.voxelM,
            bakeMs: bark?.bakeMs,
            simplify: sim
              ? `${(sim.reduction * 100).toFixed(0)}% (${sim.trianglesBefore}→${sim.trianglesAfter})`
              : null,
            drawCalls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            canopyCount: engine.canopy?.placed ?? engine.canopy?.count
          };
        }
      }
    });
    const queryLook = parseRenderLookId(qcParamsEarly.get('look'));
    if (queryLook) gui?.setRenderLook(queryLook);
  }
} catch (err) {
  console.error(err);
  tel.event('boot-error', err);
  window.__SAKURA_QC.error = String(err?.stack || err);
  window.__SAKURA_QC.booting = false;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  postFX.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

let _lastFrameT = performance.now();
window.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  if (e.key === 'f' || e.key === 'F') perfHud.toggle();
  if (e.key === 'c' || e.key === 'C') {
    cinema.toggle();
    gui?.syncCinema?.();
  }
  if (e.key === '[') {
    if (!cinema.enabled) cinema.setEnabled(true);
    cinema.cycle(-1);
    gui?.syncCinema?.();
  }
  if (e.key === ']') {
    if (!cinema.enabled) cinema.setEnabled(true);
    cinema.cycle(1);
    gui?.syncCinema?.();
  }
});

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const wall = now - _lastFrameT;
  const dt = Math.min(0.1, wall / 1000);
  _lastFrameT = now;
  tel.beginFrame(wall);
  const viewCam = engine?.sceneComposer?.mode === 'topdown' ? engine.sceneComposer.camera : camera;
  perfHud.frame({
    scene,
    camera: viewCam,
    renderer,
    update() {
      tel.guard('update', () => {
        const sc = engine?.sceneComposer;
        const topdown = sc?.mode === 'topdown';
        if (cinema.enabled && !topdown) {
          cinema.tick(dt);
        } else if (!topdown) {
          controls.update();
          if (!qcMode) {
            // never let the camera sink into the rolling meadow
            const floor = heightAt(camera.position.x, camera.position.z) + 0.3;
            if (camera.position.y < floor) camera.position.y = floor;
          }
        }
        engine?.tick(topdown ? sc.camera : camera);
      });
    },
    render: () =>
      tel.guard('render', () => {
        const sc = engine?.sceneComposer;
        if (sc?.mode === 'topdown') {
          renderer.render(scene, sc.camera);
        } else {
          postFX.render();
        }
      })
  });
  if (hud) {
    const bake = engine?.barkMesh ? 'bark:on' : engine ? 'bark:pending' : 'boot-fail';
    const sk = engine?.skeleton;
    const skInfo = sk ? ` · sk ${sk.nodes.length}n/${sk.edges.length}e` : '';
    const ts = engine?.treeSpec;
    const size = ts ? `H=${ts.heightM.toFixed(1)}m R=${ts.crownRadiusM.toFixed(1)}m` : '';
    const clock = engine?.atmosphere ? ` · ${engine.atmosphere.clockLabel} ${engine.atmosphere.periodLabel}` : '';
    const cine = cinema.enabled
      ? ` · cine ${CINEMATIC_MODE_IDS.includes(cinema.mode) ? cinema.snapshot().shot || cinema.mode : cinema.mode}`
      : '';
    const telErr = tel.lastError ? ` · ERR ${tel.lastError.slice(0, 90)}` : '';
    hud.textContent = `SI · 1u=1m · ${size} · ${bake}${skInfo}${clock}${cine}${telErr} · [\`] panel · [C] cine · [ ]/[ ] mood · [F] fps`;
  }
}
frame();
