/**
 * EffectComposer replaces the default render target, so MSAA is lost — SMAA restores edge AA.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

const GODRAYS_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uSunPos: { value: new THREE.Vector2(0.5, 0.7) },
    uIntensity: { value: 0.35 },
    uDensity: { value: 0.92 },
    uWeight: { value: 0.35 },
    uDecay: { value: 0.94 },
    uExposure: { value: 0.35 },
    uEnabled: { value: 1 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunPos;
    uniform float uIntensity;
    uniform float uDensity;
    uniform float uWeight;
    uniform float uDecay;
    uniform float uExposure;
    uniform float uEnabled;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uEnabled < 0.5 || uIntensity < 0.001) {
        gl_FragColor = base;
        return;
      }
      vec2 delta = (vUv - uSunPos) * (1.0 / 12.0) * uDensity;
      vec2 uv = vUv;
      vec3 acc = vec3(0.0);
      float illum = 1.0;
      for (int i = 0; i < 12; i++) {
        uv -= delta;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb;
        float lum = dot(s, vec3(0.299, 0.587, 0.114));
        acc += s * step(0.55, lum) * illum * uWeight;
        illum *= uDecay;
      }
      vec3 shafts = acc * uExposure * uIntensity;
      gl_FragColor = vec4(base.rgb + shafts, base.a);
    }
  `
};

/**
 * @param {{
 *   renderer: THREE.WebGLRenderer,
 *   scene: THREE.Scene,
 *   camera: THREE.Camera,
 *   getSunDir?: () => THREE.Vector3,
 * }} opts
 */
export function createPostFX(opts) {
  const { renderer, scene, camera } = opts;
  const size = new THREE.Vector2();
  renderer.getSize(size);

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.55, 0.88);
  bloom.threshold = 0.88;
  bloom.strength = 0.22;
  bloom.radius = 0.55;
  composer.addPass(bloom);

  const godrays = new ShaderPass(GODRAYS_SHADER);
  composer.addPass(godrays);

  const smaa = new SMAAPass(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio());
  composer.addPass(smaa);

  const output = new OutputPass();
  composer.addPass(output);

  const _sun = new THREE.Vector3();
  const _ndc = new THREE.Vector3();

  let enabled = true;
  let bloomAmt = 1;
  let raysAmt = 1;
  let bloomBase = { strength: 0.22, radius: 0.55, threshold: 0.88 };
  let rayScaleBase = 1;
  let gradePass = null;
  let viewW = size.x;
  let viewH = size.y;

  function syncBloomFromLookBases() {
    bloom.strength = bloomBase.strength * bloomAmt;
    bloom.radius = bloomBase.radius;
    bloom.threshold = bloomBase.threshold;
    bloom.enabled = bloom.strength > 0.01;
  }

  function syncGradeTexel() {
    const texel = gradePass?.uniforms?.uTexel?.value;
    if (!texel) return;
    const pr = renderer.getPixelRatio();
    texel.set(1 / Math.max(1, viewW * pr), 1 / Math.max(1, viewH * pr));
  }

  function syncSunScreen() {
    const dir = opts.getSunDir?.();
    if (!dir || dir.y < -0.02) {
      godrays.uniforms.uEnabled.value = 0;
      return;
    }
    _sun.copy(dir).multiplyScalar(800).add(camera.position);
    _ndc.copy(_sun).project(camera);
    const onScreen = _ndc.z < 1 && Math.abs(_ndc.x) < 1.35 && Math.abs(_ndc.y) < 1.35;
    const lowSun = THREE.MathUtils.clamp(1.15 - Math.abs(dir.y) * 2.2, 0, 1);
    const vis = onScreen && dir.y > -0.02 ? lowSun * raysAmt : 0;
    godrays.uniforms.uEnabled.value = vis > 0.02 ? 1 : 0;
    godrays.uniforms.uIntensity.value = (0.22 + 0.55 * lowSun) * rayScaleBase * raysAmt;
    godrays.uniforms.uSunPos.value.set(_ndc.x * 0.5 + 0.5, _ndc.y * 0.5 + 0.5);
  }

  syncBloomFromLookBases();

  return {
    composer,
    bloom,
    godrays,
    get enabled() {
      return enabled;
    },
    setEnabled(v) {
      enabled = Boolean(v);
    },
    setBloom(amount) {
      bloomAmt = Math.max(0, amount);
      syncBloomFromLookBases();
    },
    setGodrays(amount) {
      raysAmt = Math.max(0, amount);
    },
    setLookBases(bloomDoc, rayScale) {
      bloomBase = {
        strength: bloomDoc.strength,
        radius: bloomDoc.radius,
        threshold: bloomDoc.threshold
      };
      rayScaleBase = rayScale;
      syncBloomFromLookBases();
    },
    installGrade(pass) {
      if (gradePass) throw new Error('grade pass already installed');
      const at = composer.passes.indexOf(smaa);
      if (at < 0) throw new Error('SMAA pass missing');
      gradePass = pass;
      composer.insertPass(pass, at);
      syncGradeTexel();
    },
    get grade() {
      return gradePass;
    },
    setSize(w, h) {
      viewW = w;
      viewH = h;
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio();
      smaa.setSize(w * pr, h * pr);
      bloom.setSize(w, h);
      syncGradeTexel();
    },
    render() {
      if (!enabled) {
        renderer.render(scene, camera);
        return;
      }
      syncBloomFromLookBases();
      syncSunScreen();
      composer.render();
    }
  };
}
