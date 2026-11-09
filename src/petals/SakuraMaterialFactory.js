import * as THREE from 'three';

/**
 * Shared Kanzan blossom / petal material — soft edge fade, double-sided.
 * Used by canopy clusters and falling petals (same shader).
 */
export class SakuraMaterialFactory {
  /**
   * @returns {THREE.MeshStandardMaterial}
   */
  static createBlossomMaterial() {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xff8fbc),
      emissive: new THREE.Color(0xff5a9e),
      emissiveIntensity: 0.22,
      roughness: 0.62,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1.0,
      // Soft edge fade + alphaTest; depthWrite needed so blossoms receive/cast shadows
      alphaTest: 0.08,
      depthWrite: true
    });

    material.userData.uniforms = {
      uTime: { value: 0 },
      uWindStrength: { value: 0.3 },
      uWindDirection: { value: new THREE.Vector3(1.0, 0.2, 0.5).normalize() },
      uPetalCore: { value: new THREE.Color(0xff4d8f) },
      uPetalRim: { value: new THREE.Color(0xffe6f2) },
      uNormalBlend: { value: 0.25 },
      uFlutterAmpM: { value: 0.008 },
      uBrightBoost: { value: 0.28 },
      /** 0 = opaque core only · 1 = strong rim dissolve */
      uEdgeFade: { value: 0.85 }
    };

    material.onBeforeCompile = (shader) => {
      const u = material.userData.uniforms;
      Object.assign(shader.uniforms, {
        uTime: u.uTime,
        uWindStrength: u.uWindStrength,
        uWindDirection: u.uWindDirection,
        uPetalCore: u.uPetalCore,
        uPetalRim: u.uPetalRim,
        uNormalBlend: u.uNormalBlend,
        uFlutterAmpM: u.uFlutterAmpM,
        uBrightBoost: u.uBrightBoost,
        uEdgeFade: u.uEdgeFade
      });

      shader.vertexShader = `
        attribute vec3 aClusterCenter;
        attribute float aInstancePhase;
        uniform float uTime;
        uniform float uWindStrength;
        uniform vec3 uWindDirection;
        uniform float uNormalBlend;
        uniform float uFlutterAmpM;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;
        varying float vPetalV;
        varying vec2 vPetalUv;
        ${shader.vertexShader}
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vPetalV = uv.y;
        vPetalUv = uv;
        float phase = aInstancePhase;
        float flutter = sin(uTime * 3.6 + phase + transformed.x * 50.0) *
                        cos(uTime * 2.2 + transformed.y * 36.0);
        float gust = sin(uTime * 1.0 + phase * 0.37) * 0.5 + 0.5;
        float amp = uFlutterAmpM * uWindStrength * (0.6 + 0.4 * gust);
        transformed += uWindDirection * (flutter * amp);
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        #include <project_vertex>
        #ifdef USE_INSTANCING
          vec3 worldPosInst = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
          vec3 worldN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
        #else
          vec3 worldPosInst = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 worldN = normalize(mat3(modelMatrix) * objectNormal);
        #endif
        vWorldPos = worldPosInst;
        vec3 toMacro = worldPosInst - aClusterCenter;
        float macroLen = length(toMacro);
        vec3 macroWorld = macroLen > 1e-4 ? toMacro / macroLen : worldN;
        worldN = normalize(mix(worldN, macroWorld, uNormalBlend * 0.4));
        vWorldNormal = worldN;
        vNormal = normalize(normalMatrix * (mat3(viewMatrix) * worldN));
        `
      );

      shader.fragmentShader = `
        uniform vec3 uPetalCore;
        uniform vec3 uPetalRim;
        uniform float uBrightBoost;
        uniform float uEdgeFade;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;
        varying float vPetalV;
        varying vec2 vPetalUv;
        ${shader.fragmentShader}
      `;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>
        if (!gl_FrontFacing) normal = -normal;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        vec3 n = normalize(vWorldNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 lightDir = normalize(vec3(0.4, 0.95, 0.2));
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float ndl = max(0.0, dot(n, lightDir));
        float wrap = max(0.35, (ndl + 0.75) / 1.75);
        float rim = pow(1.0 - max(0.0, dot(n, viewDir)), 2.2);
        float coreMix = smoothstep(0.15, 0.85, 1.0 - vPetalV);
        vec3 petal = mix(diffuseColor.rgb, uPetalCore, coreMix * 0.55);
        petal = mix(petal, uPetalRim, rim * 0.55 + ndl * 0.15);
        gl_FragColor.rgb = petal * (0.72 + 0.42 * wrap) + petal * uBrightBoost * 0.28;
        gl_FragColor.rgb += uPetalRim * rim * 0.15;
        gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(1.05));

        // Soft transparency toward mesh edges (UV silhouette of each petal lamina)
        vec2 e = abs(vPetalUv - vec2(0.5));
        float edgeU = smoothstep(0.48, 0.22, e.x);
        float edgeV = smoothstep(0.0, 0.06, vPetalUv.y) * smoothstep(1.0, 0.78, vPetalUv.y);
        float soft = edgeU * edgeV;
        // Extra radial dissolve near the outline
        float radial = 1.0 - smoothstep(0.28, 0.55, length(vec2(e.x * 1.15, e.y * 0.95)));
        soft *= mix(0.55, 1.0, radial);
        float edgeAlpha = mix(1.0, soft, clamp(uEdgeFade, 0.0, 1.0));
        gl_FragColor.a *= edgeAlpha * diffuseColor.a;
        `
      );

      material.userData.shader = shader;
    };

    material.customProgramCacheKey = () => 'sakura-blossom-edgefade-v1';
    return material;
  }

  static updateBlossomMaterial(material, time, windStrength) {
    const u = material?.userData?.uniforms;
    if (!u) return;
    u.uTime.value = time;
    if (windStrength !== undefined) u.uWindStrength.value = windStrength;
  }
}
