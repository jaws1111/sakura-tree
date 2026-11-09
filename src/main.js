import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CAMERA_EYE_M,
  PARK_EXTENT_M,
  TREE_HEIGHT_M,
  TRUNK_BASE_RADIUS_M
} from './units.js';
import { heightAt } from './env/terrain.js';
import { ProceduralSakuraEngine } from './engine/ProceduralSakuraEngine.js';
import { DebugOverlay } from './debug/DebugOverlay.js';
import { mountAnalysisGui } from './debug/AnalysisGui.js';

const canvas = document.querySelector('#app');
const qcParamsEarly = new URLSearchParams(location.search);
const qcModeEarly = qcParamsEarly.get('qc') === '1';
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: qcModeEarly
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8c8d0);
scene.fog = new THREE.Fog(0xd8c8d0, 35, 110);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.05,
  250
);
camera.position.set(7.5, CAMERA_EYE_M + 1.2, 11.5);
camera.lookAt(0, TREE_HEIGHT_M * 0.45, 0);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, TREE_HEIGHT_M * 0.4, 0);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 1.5;
controls.maxDistance = PARK_EXTENT_M * 0.9;
controls.enableDamping = true;

const cal = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x88aadd, roughness: 0.35 })
);
cal.position.set(-2.2, heightAt(-2.2, 2.5) + 0.5, 2.5);
cal.castShadow = true;
scene.add(cal);

const human = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.18, 1.34, 4, 8),
  new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.85 })
);
human.position.set(-2.2, heightAt(-2.2, 3.6) + 0.85, 3.6);
human.castShadow = true;
scene.add(human);

const hud = document.querySelector('#hud');
const qcMode = qcModeEarly;
const refs = { cal, human };

const overlay = new DebugOverlay(scene);

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
      barkBoundsY: bark?.boundsMinM
        ? [bark.boundsMinM.y, bark.boundsMaxM.y]
        : null,
      rootEdges: sk?.stats?.rootEdges ?? null,
      shootEdges: sk?.stats?.shootEdges ?? null,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      hasCanopy: Boolean(eng.canopy?.meshNear || eng.canopy?.mesh),
      hasGrass: Boolean(eng.grass),
      hasMoss: Boolean(eng.moss),
      hasFallingPetals: Boolean(eng.fallingPetals),
      canopyCount: eng.canopy?.count ?? null,
      fallingCount: eng.fallingPetals?.count ?? null,
      budget: eng.budget?.estimate ?? null,
      camera: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z
      }
    };
  },
  setCamera(x, y, z, tx = 0, ty = TREE_HEIGHT_M * 0.4, tz = 0) {
    camera.position.set(x, y, z);
    controls.target.set(tx, ty, tz);
    controls.update();
  }
};

function syncDebugFromEngine(eng) {
  overlay.syncSkeleton(eng?.skeleton ?? null);
  overlay.syncBarkMesh(eng?.barkMesh ?? null);
  overlay.apply(eng, refs);
}

function setCameraPreset(name) {
  const presets = {
    hero: { p: [7.5, CAMERA_EYE_M + 1.2, 11.5], t: [0, TREE_HEIGHT_M * 0.4, 0] },
    trunk: { p: [3.2, 1.8, 4.5], t: [0, 1.4, 0] },
    roots: { p: [2.8, 0.4, 3.6], t: [0, -0.4, 0] },
    top: { p: [0.2, 16, 0.2], t: [0, 4, 0] },
    wire: { p: [1.8, 2.4, 2.4], t: [0, 2.0, 0] }
  };
  const c = presets[name] || presets.hero;
  camera.position.set(...c.p);
  controls.target.set(...c.t);
  controls.update();
}

let engine;
let gui = null;
try {
  engine = new ProceduralSakuraEngine(scene, renderer, {
    deferredBake: !qcMode,
    autoBake: false,
    paused: qcMode,
    bark: qcMode
      ? { voxelM: 0.22, attractorCount: 220, maxIterations: 55 }
      : undefined,
    grass: qcMode ? { maxCount: 8_000, spacing: 0.18 } : undefined,
    canopyCount: qcMode ? 400 : undefined,
    fallingPetalCount: qcMode ? 400 : undefined,
    canopyQuality: qcMode ? 'lite' : 'lite',
    petalMode: 'CURL_NOISE'
  });
  window.__SAKURA_QC.engine = engine;
  window.__SAKURA_QC.ready = true;
  window.__SAKURA_QC.booting = false;
  window.__SAKURA_QC.setPaused = (v) => {
    if (engine) engine.paused = Boolean(v);
  };

  engine.onBarkBaked = () => {
    syncDebugFromEngine(engine);
    gui?.updateStats?.();
  };

  if (!qcMode) {
    gui = mountAnalysisGui({
      overlay,
      engine,
      refs,
      onRebuild: (params) => {
        Object.assign(engine.barkMesher.defaults, params);
        hud && (hud.textContent = 'Baking bark…');
        // Yield so the HUD paints before the sync bake stalls the main thread
        setTimeout(() => {
          try {
            engine.bakeBark(params);
            syncDebugFromEngine(engine);
            gui?.updateStats?.();
          } catch (err) {
            console.error(err);
            if (hud) hud.textContent = `Bake failed: ${err?.message || err}`;
          }
        }, 30);
      },
      onCanopyCount: (n) => {
        const applied = engine.canopy?.setCount?.(n);
        if (engine.budget?.config && applied != null) {
          engine.budget.config.canopyCount = applied;
        }
        engine.syncFallingFromCanopy?.();
        gui?.updateStats?.();
      },
      onCanopySize: (s) => {
        engine.canopy?.setSize?.(s);
        engine.syncFallingFromCanopy?.();
        gui?.updateStats?.();
      },
      onPeduncleScale: (s) => {
        engine.canopy?.setPeduncleScale?.(s);
        engine.syncFallingFromCanopy?.();
        gui?.updateStats?.();
      },
      onBlossomRender: (opts) => {
        engine.canopy?.setRenderOptions?.(opts);
        if (opts.exposure != null) renderer.toneMappingExposure = opts.exposure;
        if (opts.sunIntensity != null && engine.sun) engine.sun.intensity = opts.sunIntensity;
        if (opts.hemiIntensity != null && engine.hemi) engine.hemi.intensity = opts.hemiIntensity;
        gui?.updateStats?.();
      },
      onPreset: (name) => {
        overlay.applyPreset(name, engine, refs);
        if (name === 'roots') setCameraPreset('roots');
        if (name === 'mesh') setCameraPreset('wire');
        if (name === 'skeleton') setCameraPreset('hero');
        gui?.updateStats?.();
      },
      onCamera: setCameraPreset,
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
    });
  }
} catch (err) {
  console.error(err);
  window.__SAKURA_QC.error = String(err?.stack || err);
  window.__SAKURA_QC.booting = false;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

function frame() {
  requestAnimationFrame(frame);
  controls.update();
  engine?.tick(camera);
  renderer.render(scene, camera);
  if (hud) {
    const bake = engine?.barkMesh ? 'bark:on' : engine ? 'bark:pending' : 'boot-fail';
    const sk = engine?.skeleton;
    const skInfo = sk
      ? ` · sk ${sk.nodes.length}n/${sk.edges.length}e`
      : '';
    hud.textContent =
      `SI · 1u=1m · H=${TREE_HEIGHT_M}m · bole r=${TRUNK_BASE_RADIUS_M}m · ${bake}${skInfo} · [\`] panel · [1-5] presets`;
  }
}
frame();
