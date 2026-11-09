import * as THREE from 'three';

/**
 * Shared blossom material — folded-plane petal SDF, edge fade, contact AO.
 * Same ShaderMaterial for canopy blossoms and falling petals.
 */
export class SakuraMaterialFactory {
  /**
   * @returns {THREE.ShaderMaterial}
   */
  static createBlossomMaterial() {
    const uniforms = {
      // Tip / outer (more saturated pink) — matches reference gradient
      uColorPrimary: { value: new THREE.Color(0xff8fb8) },
      // Near flower eye (lighter) — AO darkens contact separately
      uColorCenter: { value: new THREE.Color(0xfff2f7) },
      uEdgeFade: { value: 0.045 },
      uOpacity: { value: 0.94 },
      uBrightBoost: { value: 0.1 },
      uAOStrength: { value: 0.55 },
      uTime: { value: 0 },
      uWindStrength: { value: 0.3 },
      uWindDirection: { value: new THREE.Vector3(1.0, 0.2, 0.5).normalize() },
      uFlutterAmpM: { value: 0.006 }
    };

    const material = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      alphaTest: 0.04,
      uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aClusterCenter;
        attribute float aInstancePhase;
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec3 uWindDirection;
        uniform float uFlutterAmpM;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying float vCenterDist;

        void main() {
          vUv = uv;
          vec3 pos = position;
          // Subtle cup along the fold
          pos.z += sin(uv.y * 3.14159) * 0.04 * (1.0 - abs(uv.x - 0.5) * 2.0)
                   * max(length(position.xy), 0.01) * 0.55;

          float phase = aInstancePhase;
          float flutter = sin(uTime * 3.6 + phase + pos.x * 40.0) *
                          cos(uTime * 2.2 + pos.y * 30.0);
          float gust = sin(uTime * 1.0 + phase * 0.37) * 0.5 + 0.5;
          float amp = uFlutterAmpM * uWindStrength * (0.55 + 0.45 * gust);
          pos += uWindDirection * (flutter * amp);

          vec4 world = modelMatrix * instanceMatrix * vec4(pos, 1.0);
          vWorldPos = world.xyz;
          // Distance from blossom instance center — contact AO near the eye
          vCenterDist = length(pos.xyz);
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColorPrimary;
        uniform vec3 uColorCenter;
        uniform float uEdgeFade;
        uniform float uOpacity;
        uniform float uBrightBoost;
        uniform float uAOStrength;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying float vCenterDist;

        // Rounded sakura leaf + apical notch (reference heart tip)
        float petalSDF(vec2 p) {
          vec2 q = p;
          q.x *= 1.05;
          q.y *= 0.92;
          float body = length(q / vec2(0.40, 0.55)) - 1.0;
          body = max(body, q.y - 0.52);
          body = max(body, -q.y - 0.48);
          float baseTaper = smoothstep(-0.15, -0.45, q.y);
          body += baseTaper * abs(q.x) * 0.35;
          // Soft V-notch at the tip
          float notch = 0.11 - length(vec2(q.x * 2.8, q.y - 0.42));
          body = max(body, notch);
          return body;
        }

        void main() {
          vec2 p = (vUv - 0.5) * vec2(1.0, 1.3);
          float d = petalSDF(p);

          float edge = smoothstep(uEdgeFade, 0.0, d);
          float alpha = edge * uOpacity;
          if (d > 0.0 || alpha < 0.04) discard;

          // Light near base / eye → saturated primary toward tip (reference)
          float grad = smoothstep(-0.28, 0.38, p.y);
          vec3 color = mix(uColorCenter, uColorPrimary, grad);

          float vein = smoothstep(0.022, 0.0, abs(p.x)) * (1.0 - smoothstep(-0.1, 0.5, p.y));
          color += vein * 0.06;
          color += color * uBrightBoost * 0.3;

          // --- Contact / cavity AO (what made blossoms look flat) ---
          // 1) Darken toward flower eye (petal bases meet)
          float eyeAo = smoothstep(0.028, 0.004, vCenterDist);
          // 2) Darken along petal base in UV
          float baseAo = 1.0 - smoothstep(-0.45, -0.05, p.y);
          // 3) Soft crease AO down the midrib fold
          float creaseAo = smoothstep(0.08, 0.0, abs(p.x)) * (0.35 + 0.65 * baseAo);
          // 4) Edge contact where lamina thins
          float rimAo = smoothstep(0.02, -0.02, d) * 0.25;
          float ao = 1.0 - uAOStrength * clamp(
            eyeAo * 0.75 + baseAo * 0.45 + creaseAo * 0.28 + rimAo,
            0.0,
            0.85
          );
          color *= ao;

          // Soft lambert from face normal (derivatives)
          vec3 lightDir = normalize(vec3(0.35, 0.9, 0.25));
          vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
          float ndl = abs(dot(n, lightDir));
          color *= 0.68 + 0.38 * ndl;

          gl_FragColor = vec4(min(color, vec3(1.05)), alpha);
        }
      `
    });

    material.color = uniforms.uColorPrimary.value;
    material.emissive = uniforms.uColorCenter.value;
    material.emissiveIntensity = 0;
    material.roughness = 0.6;
    material.opacity = uniforms.uOpacity.value;
    material.userData.uniforms = {
      ...uniforms,
      uPetalCore: uniforms.uColorCenter,
      uPetalRim: uniforms.uColorPrimary
    };
    material.userData.isBlossomShader = true;
    material.customProgramCacheKey = () => 'sakura-folded-petal-ao-v2';
    return material;
  }

  static updateBlossomMaterial(material, time, windStrength) {
    const u = material?.userData?.uniforms;
    if (!u) return;
    if (u.uTime) u.uTime.value = time;
    if (windStrength !== undefined && u.uWindStrength) {
      u.uWindStrength.value = windStrength;
    }
  }
}
