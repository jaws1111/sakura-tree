import * as THREE from 'three';

/**
 * Bake the procedural sky into a PMREM environment map for MeshStandard/Physical IBL
 * (bark / moss / terrain specular). Rebaked when solar elevation drifts enough.
 */
export function createPmremSky({ renderer, scene, skyMesh }) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();

  let envRT = null;
  let environmentIntensity = 0.55;
  let lastSunY = Infinity;
  let lastCloud = Infinity;
  let lastHours = Infinity;
  const scratchScene = new THREE.Scene();
  const cam = new THREE.CubeCamera(0.1, 10000, new THREE.WebGLCubeRenderTarget(256, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace
  }));

  function disposeEnv() {
    if (envRT) {
      envRT.dispose();
      envRT = null;
    }
    if (scene.environment) scene.environment = null;
  }

  /**
   * @param {{ sunDirY?: number, cloudCover?: number, hours?: number, force?: boolean }} [opts]
   */
  function bake(opts = {}) {
    if (!skyMesh) return null;
    const sunY = opts.sunDirY ?? 0;
    const cloud = opts.cloudCover ?? 0;
    const hours = opts.hours ?? 0;
    if (
      !opts.force &&
      Math.abs(sunY - lastSunY) < 0.04 &&
      Math.abs(cloud - lastCloud) < 0.08 &&
      Math.abs(hours - lastHours) < 0.35
    ) {
      return envRT;
    }
    lastSunY = sunY;
    lastCloud = cloud;
    lastHours = hours;

    try {
      const parent = skyMesh.parent;
      const pos = skyMesh.position.clone();
      scratchScene.add(skyMesh);
      skyMesh.position.set(0, 0, 0);
      cam.update(renderer, scratchScene);
      if (parent) parent.add(skyMesh);
      skyMesh.position.copy(pos);

      disposeEnv();
      envRT = pmrem.fromCubemap(cam.renderTarget.texture);
      scene.environment = envRT.texture;
      scene.environmentIntensity = environmentIntensity;
      return envRT;
    } catch (err) {
      console.warn('[PMREM] bake failed', err);
      if (skyMesh.parent !== scene && scene) scene.add(skyMesh);
      return null;
    }
  }

  function dispose() {
    disposeEnv();
    cam.renderTarget.dispose();
    pmrem.dispose();
  }

  function setIntensity(intensity) {
    environmentIntensity = intensity;
    if (scene.environment) scene.environmentIntensity = intensity;
  }

  return { bake, dispose, setIntensity, get texture() { return envRT?.texture ?? null; } };
}
