import * as THREE from 'three';
import {
  G_EARTH,
  TREE_HEIGHT_M,
  CROWN_RADIUS_M,
  PETAL_LENGTH_M,
  V_TERM_PETAL_MPS,
  WIND_AMBIENT_MPS
} from '../units.js';
import { heightAt as terrainHeightAt, normalAt as terrainNormalAt } from '../env/terrain.js';
import { SakuraMaterialFactory } from './SakuraMaterialFactory.js';

export const PETAL_DRIFT_MODE = Object.freeze({
  CURL_NOISE: 'CURL_NOISE',
  BOIDS: 'BOIDS'
});

/** Boids neighborhood radius (m) — §5.2. */
const BOIDS_RADIUS_M = 0.45;

/** Horizontal slide damping on ground (s⁻¹) — §5.3. */
const K_SLIDE = 4.0;

/** Soft wind steer gain (s⁻¹). */
const K_WIND = 0.55;

/** Curl field steer gain (s⁻¹). */
const K_CURL = 2.5;

/** Lift coefficient for AoA-modulated gravity (§5.2). */
const C_LIFT = 0.55;

/**
 * Equal-disk center distance below which intersection / diskArea ≥ ~0.60.
 * For unit disks, area fraction 0.6 ⇒ d/R ≈ 0.70.
 */
const OVERLAP_DIST_FACTOR = 0.7;

/**
 * Dual-mode falling petal drift: CURL_NOISE | BOIDS.
 * Uses the same blossom mesh + material as the canopy when provided.
 * SI — positions m, velocities m·s⁻¹, accelerations m·s⁻², Δt s.
 */
export class FallingPetalDriftSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {number} [count=3000]
   * @param {object} [opts]
   * @param {{ x: number, y: number, z: number }} [opts.bounds]
   * @param {THREE.BufferGeometry} [opts.geometry] shared canopy blossom mesh
   * @param {THREE.Material} [opts.material] shared canopy blossom material
   */
  constructor(scene, count = 3000, opts = {}) {
    const bounds =
      opts.bounds ??
      (opts.x != null ? opts : { x: 20, y: TREE_HEIGHT_M + 1, z: 20 });
    this.count = count;
    this.bounds = bounds;
    this.mode = PETAL_DRIFT_MODE.BOIDS;
    this.gravity = new THREE.Vector3(G_EARTH.x, G_EARTH.y, G_EARTH.z);
    this.vTerm = V_TERM_PETAL_MPS;
    this.windAmbient = new THREE.Vector3(WIND_AMBIENT_MPS, 0, 0.25);
    /** Match canopy blossom sizeScale (1 = default petal metres). */
    this.petalScale = 1;
    /** Wood attach seats from canopy (Float32Array xyz triplets) — null = crown AABB. */
    this.attachPoints = null;
    this.attachCount = 0;
    this.heightAt =
      typeof terrainHeightAt === 'function' ? terrainHeightAt : () => 0;
    this.normalAt =
      typeof terrainNormalAt === 'function'
        ? terrainNormalAt
        : (_x, _z, target = new THREE.Vector3()) => target.set(0, 1, 0);

    // Same blossom mesh (cloned so instance attrs don't clash) + shared material
    this._ownsGeometry = true;
    this._ownsMaterial = !opts.material;
    this.geometry = opts.geometry
      ? opts.geometry.clone()
      : new THREE.PlaneGeometry(0.014, 0.018, 2, 3);
    // Drop canopy instance attrs from the clone; we bind our own below
    this.geometry.deleteAttribute('aClusterCenter');
    this.geometry.deleteAttribute('aInstancePhase');
    this.material = opts.material ?? SakuraMaterialFactory.createBlossomMaterial();
    if (opts.material) this.material.userData.shared = true;

    this.instancedMesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.castShadow = true;
    this.instancedMesh.receiveShadow = true;
    this.instancedMesh.name = 'fallingPetals';

    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.rotations = new Float32Array(count * 3);
    this.rotVelocities = new Float32Array(count * 3);
    /** Settle age (s); < 0 = airborne. */
    this.settleAge = new Float32Array(count);
    this.settleAge.fill(-1);
    /** Kept for API compat — ground petals stay until overlap-culled. */
    this.settleLimit = new Float32Array(count);
    /** Spatial hash of settled petals: cellKey → instance indices */
    this._groundHash = new Map();
    this._groundCell = Math.max(0.04, PETAL_LENGTH_M * 1.2);
    this.groundCount = 0;
    this._yawQ = new THREE.Quaternion();

    // Shader attrs required by shared blossom material
    this._clusterCenters = new Float32Array(count * 3);
    this._phases = new Float32Array(count);
    for (let i = 0; i < count; i++) this._phases[i] = Math.random() * Math.PI * 2;
    this._centerAttr = new THREE.InstancedBufferAttribute(this._clusterCenters, 3);
    this._phaseAttr = new THREE.InstancedBufferAttribute(this._phases, 1);
    this._centerAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aClusterCenter', this._centerAttr);
    this.geometry.setAttribute('aInstancePhase', this._phaseAttr);

    this.dummy = new THREE.Object3D();
    this._curl = new THREE.Vector3();
    this._groundN = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._up = new THREE.Vector3(0, 1, 0);
    this._petalN = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._torque = new THREE.Vector3();

    this.initParticles();
    scene.add(this.instancedMesh);
  }

  /**
   * Rebind to canopy blossom mesh + material (same assets as tree blossoms).
   * Geometry is cloned; material is shared by reference.
   * @param {THREE.BufferGeometry} geometry
   * @param {THREE.Material} material
   */
  setSharedAssets(geometry, material) {
    if (!geometry || !material) return;
    const oldGeo = this.geometry;
    const oldMat = this.material;

    const clone = geometry.clone();
    clone.deleteAttribute('aClusterCenter');
    clone.deleteAttribute('aInstancePhase');
    clone.setAttribute('aClusterCenter', this._centerAttr);
    clone.setAttribute('aInstancePhase', this._phaseAttr);

    this.geometry = clone;
    this.material = material;
    this.material.userData.shared = true;
    this._ownsGeometry = true;
    this._ownsMaterial = false;

    this.instancedMesh.geometry = clone;
    this.instancedMesh.material = material;

    if (oldGeo && oldGeo !== clone) oldGeo.dispose();
    if (this._ownsMaterial === false && oldMat && oldMat !== material && oldMat.userData?.shared !== true) {
      // previous owned fallback material
    } else if (oldMat && oldMat !== material && !oldMat.userData?.shared) {
      oldMat.dispose();
    }
  }

  initParticles() {
    for (let i = 0; i < this.count; i++) {
      this.resetParticle(i, true);
    }
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Bind spawn seats to small-branch blossom attach points from the canopy.
   * @param {Float32Array|null} points xyz triplets
   */
  setAttachPoints(points) {
    if (points && points.length >= 3) {
      this.attachPoints = points;
      this.attachCount = Math.floor(points.length / 3);
    } else {
      this.attachPoints = null;
      this.attachCount = 0;
    }
  }

  /**
   * Match falling petal visual size to canopy blossom sizeScale.
   * @param {number} s
   */
  setPetalScale(s) {
    this.petalScale = Math.max(0.2, Math.min(4, Number(s) || 1));
    this._groundCell = Math.max(0.04, PETAL_LENGTH_M * this.petalScale * 1.2);
  }

  #groundKey(x, z) {
    const c = this._groundCell;
    return `${Math.floor(x / c)},${Math.floor(z / c)}`;
  }

  #groundRadius() {
    return PETAL_LENGTH_M * 0.55 * (this.petalScale || 1);
  }

  #removeFromGroundHash(i) {
    const i3 = i * 3;
    const key = this.#groundKey(this.positions[i3], this.positions[i3 + 2]);
    const bucket = this._groundHash.get(key);
    if (!bucket) return;
    const idx = bucket.indexOf(i);
    if (idx >= 0) {
      bucket.splice(idx, 1);
      this.groundCount = Math.max(0, this.groundCount - 1);
    }
    if (bucket.length === 0) this._groundHash.delete(key);
  }

  #addToGroundHash(i) {
    const i3 = i * 3;
    const key = this.#groundKey(this.positions[i3], this.positions[i3 + 2]);
    let bucket = this._groundHash.get(key);
    if (!bucket) {
      bucket = [];
      this._groundHash.set(key, bucket);
    }
    if (!bucket.includes(i)) {
      bucket.push(i);
      this.groundCount += 1;
    }
  }

  /**
   * True if petal i overlaps ≥ ~60% area with any already-settled neighbor.
   */
  #overlapsGroundTooMuch(i) {
    const i3 = i * 3;
    const x = this.positions[i3];
    const z = this.positions[i3 + 2];
    const R = this.#groundRadius();
    const maxD = R * OVERLAP_DIST_FACTOR;
    const maxD2 = maxD * maxD;
    const c = this._groundCell;
    const ix = Math.floor(x / c);
    const iz = Math.floor(z / c);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this._groundHash.get(`${ix + dx},${iz + dz}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === i) continue;
          if (this.settleAge[j] < 0) continue;
          const j3 = j * 3;
          const ddx = this.positions[j3] - x;
          const ddz = this.positions[j3 + 2] - z;
          if (ddx * ddx + ddz * ddz < maxD2) return true;
        }
      }
    }
    return false;
  }

  /** Snap orientation flat to terrain (petal lies on the ground). */
  #flattenToGround(i) {
    const i3 = i * 3;
    this.normalAt(this.positions[i3], this.positions[i3 + 2], this._groundN);
    // Keep a random yaw so the carpet isn't all aligned
    const yaw = this.rotations[i3 + 1] || Math.random() * Math.PI * 2;
    this._quat.setFromUnitVectors(this._up, this._groundN);
    this._yawQ.setFromAxisAngle(this._groundN, yaw);
    this._quat.multiply(this._yawQ);
    this._euler.setFromQuaternion(this._quat, 'YXZ');
    this.rotations[i3] = this._euler.x;
    this.rotations[i3 + 1] = this._euler.y;
    this.rotations[i3 + 2] = this._euler.z;
    this.rotVelocities[i3] = 0;
    this.rotVelocities[i3 + 1] = 0;
    this.rotVelocities[i3 + 2] = 0;
  }

  /**
   * Respawn from a thin-wood attach point when available; else crown AABB.
   * @param {number} i
   * @param {boolean} [randomY]
   */
  resetParticle(i, randomY = false) {
    if (this.settleAge[i] >= 0) this.#removeFromGroundHash(i);
    const i3 = i * 3;

    if (this.attachCount > 0 && this.attachPoints) {
      const j = Math.floor(Math.random() * this.attachCount) * 3;
      // Small jitter so many petals don't stack on the exact seat
      this.positions[i3] = this.attachPoints[j] + (Math.random() - 0.5) * 0.04;
      this.positions[i3 + 1] = this.attachPoints[j + 1] + Math.random() * 0.03;
      this.positions[i3 + 2] = this.attachPoints[j + 2] + (Math.random() - 0.5) * 0.04;
    } else {
      const R = Math.min(this.bounds.x, this.bounds.z) * 0.5;
      const crownR = Math.min(R, CROWN_RADIUS_M * 1.35);
      if (Math.random() < 0.72) {
        const theta = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * crownR;
        this.positions[i3] = Math.cos(theta) * r;
        this.positions[i3 + 2] = Math.sin(theta) * r;
        const yMin = 2.0;
        const yMax = this.bounds.y;
        this.positions[i3 + 1] = randomY
          ? yMin + Math.random() * (yMax - yMin)
          : yMax * (0.65 + Math.random() * 0.35);
      } else {
        this.positions[i3] = (Math.random() - 0.5) * this.bounds.x;
        this.positions[i3 + 1] = randomY ? Math.random() * this.bounds.y : this.bounds.y;
        this.positions[i3 + 2] = (Math.random() - 0.5) * this.bounds.z;
      }
    }

    // Velocities in m·s⁻¹
    this.velocities[i3] = (Math.random() - 0.5) * 0.4 + this.windAmbient.x * 0.3;
    this.velocities[i3 + 1] = -this.vTerm * (0.5 + Math.random() * 0.5);
    this.velocities[i3 + 2] = (Math.random() - 0.5) * 0.4 + this.windAmbient.z * 0.3;

    this.rotations[i3] = Math.random() * Math.PI * 2;
    this.rotations[i3 + 1] = Math.random() * Math.PI * 2;
    this.rotations[i3 + 2] = Math.random() * Math.PI * 2;

    // Angular velocity in rad·s⁻¹
    this.rotVelocities[i3] = (Math.random() - 0.5) * 4.0;
    this.rotVelocities[i3 + 1] = (Math.random() - 0.5) * 4.0;
    this.rotVelocities[i3 + 2] = (Math.random() - 0.5) * 4.0;

    this.settleAge[i] = -1;
    this.settleLimit[i] = 8 + Math.random() * 12;

    this._writeInstance(i);
  }

  /**
   * Quadratic drag toward terminal speed (frame-rate independent).
   * a_drag = -k_d ‖v‖ v with k_d = g / v_term² so ‖v‖ → v_term under gravity.
   * @param {number} i3
   * @param {number} dt seconds
   */
  applyDrag(i3, dt) {
    const vx = this.velocities[i3];
    const vy = this.velocities[i3 + 1];
    const vz = this.velocities[i3 + 2];
    const spd = Math.hypot(vx, vy, vz) + 1e-6;
    const g = Math.abs(this.gravity.y);
    const kd = g / (this.vTerm * this.vTerm);
    const scale = kd * spd * dt;
    this.velocities[i3] -= vx * scale;
    this.velocities[i3 + 1] -= vy * scale;
    this.velocities[i3 + 2] -= vz * scale;
  }

  /**
   * Divergence-free curl velocity field (m·s⁻¹), §5.1.
   * @returns {THREE.Vector3}
   */
  computeCurl(x, y, z, time, target = this._curl) {
    const spatialFreq = 0.35; // rad·m⁻¹
    const amp = 0.35; // m·s⁻¹
    const p = spatialFreq;
    const n1 = Math.sin((y + time) * p) + Math.cos((z - time) * p);
    const n2 = Math.sin((z + time) * p) + Math.cos((x - time) * p);
    const n3 = Math.sin((x + time) * p) + Math.cos((y - time) * p);

    return target.set(
      (n3 - n2) * amp,
      (n1 - n3) * amp * 0.35,
      (n2 - n1) * amp
    );
  }

  /**
   * Petal adaxial normal from Euler (approx), for lift / torque.
   * @param {number} i3
   * @param {THREE.Vector3} target
   */
  _petalNormal(i3, target) {
    this.dummy.rotation.set(
      this.rotations[i3],
      this.rotations[i3 + 1],
      this.rotations[i3 + 2]
    );
    // Local +Z → world (PlaneGeometry / cupped petal facing)
    return target.set(0, 0, 1).applyQuaternion(this.dummy.quaternion).normalize();
  }

  _writeInstance(i) {
    const i3 = i * 3;
    this.dummy.position.set(
      this.positions[i3],
      this.positions[i3 + 1],
      this.positions[i3 + 2]
    );
    this.dummy.rotation.set(
      this.rotations[i3],
      this.rotations[i3 + 1],
      this.rotations[i3 + 2]
    );

    // Ground petals keep full size (carpet); no fade-out overflow trick
    this.dummy.scale.setScalar(this.petalScale || 1);
    this.dummy.updateMatrix();
    this.instancedMesh.setMatrixAt(i, this.dummy.matrix);

    // Keep blossom shader cluster-center attr in sync with the petal
    this._clusterCenters[i3] = this.positions[i3];
    this._clusterCenters[i3 + 1] = this.positions[i3 + 1];
    this._clusterCenters[i3 + 2] = this.positions[i3 + 2];
  }

  /**
   * Ground settle: lie flat, stop sliding, keep as carpet cover.
   * If ≥~60% overlap with an existing ground petal → recycle (no overflow).
   * @param {number} i
   * @param {number} dt
   * @param {number} groundY
   */
  _settleOnGround(i, dt, groundY) {
    const i3 = i * 3;
    const justLanded = this.settleAge[i] < 0;

    // Keep blossom above terrain so transparent edges don't z-fight / vanish
    const lift = Math.max(0.014, 0.022 * (this.petalScale || 1));
    this.positions[i3 + 1] = groundY + lift;
    this.velocities[i3] = 0;
    this.velocities[i3 + 1] = 0;
    this.velocities[i3 + 2] = 0;
    this.#flattenToGround(i);

    if (justLanded) {
      // Cull before joining the carpet if too overlapped
      if (this.#overlapsGroundTooMuch(i)) {
        this.resetParticle(i, false);
        return;
      }
      this.settleAge[i] = 0;
      this.settleLimit[i] = Infinity;
      this.#addToGroundHash(i);
    } else {
      this.settleAge[i] += dt;
      // Stay flat forever; re-snap in case terrain query drifts
      this.#flattenToGround(i);
    }
  }

  /**
   * Advance physics.
   * @param {number} dt Δt in seconds
   * @param {number} t elapsed time in seconds
   */
  update(dt, t) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 1 / 30;

    const boidsRangeSq = BOIDS_RADIUS_M * BOIDS_RADIUS_M;
    const sampleStep = 6;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const groundY = this.heightAt(this.positions[i3], this.positions[i3 + 2]);

      const lift = Math.max(0.014, 0.022 * (this.petalScale || 1));
      if (this.settleAge[i] >= 0 || this.positions[i3 + 1] <= groundY + lift * 0.5) {
        this._settleOnGround(i, dt, groundY);
        this._writeInstance(i);
        continue;
      }

      // AoA-modulated gravity (§5.2)
      this._petalNormal(i3, this._petalN);
      this._vel.set(
        this.velocities[i3],
        this.velocities[i3 + 1],
        this.velocities[i3 + 2]
      );
      const spd = this._vel.length() + 1e-6;
      const aoa = Math.abs(this._vel.dot(this._petalN) / spd);
      const gScale = 1.0 - C_LIFT * aoa;
      this.velocities[i3 + 1] += this.gravity.y * gScale * dt;

      // Ambient wind steer (m·s⁻¹)
      this.velocities[i3] +=
        (this.windAmbient.x - this.velocities[i3]) * K_WIND * dt;
      this.velocities[i3 + 2] +=
        (this.windAmbient.z - this.velocities[i3 + 2]) * K_WIND * dt;

      if (this.mode === PETAL_DRIFT_MODE.CURL_NOISE) {
        const curl = this.computeCurl(
          this.positions[i3],
          this.positions[i3 + 1],
          this.positions[i3 + 2],
          t
        );
        this.velocities[i3] += curl.x * K_CURL * dt;
        this.velocities[i3 + 1] += curl.y * K_CURL * dt;
        this.velocities[i3 + 2] += curl.z * K_CURL * dt;
      } else if (this.mode === PETAL_DRIFT_MODE.BOIDS) {
        let neighborCount = 0;
        let avgVelX = 0;
        let avgVelY = 0;
        let avgVelZ = 0;
        let avgPosX = 0;
        let avgPosY = 0;
        let avgPosZ = 0;
        let sepX = 0;
        let sepY = 0;
        let sepZ = 0;

        for (let j = 0; j < this.count; j += sampleStep) {
          if (i === j) continue;
          const j3 = j * 3;
          const dx = this.positions[i3] - this.positions[j3];
          const dy = this.positions[i3 + 1] - this.positions[j3 + 1];
          const dz = this.positions[i3 + 2] - this.positions[j3 + 2];
          const distSq = dx * dx + dy * dy + dz * dz;

          if (distSq < boidsRangeSq && distSq > 1e-4) {
            neighborCount++;
            avgVelX += this.velocities[j3];
            avgVelY += this.velocities[j3 + 1];
            avgVelZ += this.velocities[j3 + 2];
            avgPosX += this.positions[j3];
            avgPosY += this.positions[j3 + 1];
            avgPosZ += this.positions[j3 + 2];

            const invDist = 1.0 / distSq;
            sepX += dx * invDist;
            sepY += dy * invDist;
            sepZ += dz * invDist;
          }
        }

        if (neighborCount > 0) {
          const invN = 1.0 / neighborCount;
          // Alignment
          this.velocities[i3] +=
            (avgVelX * invN - this.velocities[i3]) * 0.15 * dt;
          this.velocities[i3 + 1] +=
            (avgVelY * invN - this.velocities[i3 + 1]) * 0.08 * dt;
          this.velocities[i3 + 2] +=
            (avgVelZ * invN - this.velocities[i3 + 2]) * 0.15 * dt;

          // Separation
          this.velocities[i3] += sepX * 0.08 * dt;
          this.velocities[i3 + 1] += sepY * 0.04 * dt;
          this.velocities[i3 + 2] += sepZ * 0.08 * dt;

          // Cohesion (§5.2)
          this.velocities[i3] += (avgPosX * invN - this.positions[i3]) * 0.06 * dt;
          this.velocities[i3 + 1] +=
            (avgPosY * invN - this.positions[i3 + 1]) * 0.03 * dt;
          this.velocities[i3 + 2] +=
            (avgPosZ * invN - this.positions[i3 + 2]) * 0.06 * dt;
        }
      }

      // Aerodynamic torque α ∝ v × n (§5.3)
      this._torque
        .set(this.velocities[i3], this.velocities[i3 + 1], this.velocities[i3 + 2])
        .cross(this._petalN)
        .multiplyScalar(0.8);
      this.rotVelocities[i3] += this._torque.x * dt;
      this.rotVelocities[i3 + 1] += this._torque.y * dt;
      this.rotVelocities[i3 + 2] += this._torque.z * dt;

      this.applyDrag(i3, dt);

      // Soft clamps (m·s⁻¹); fall drag-capped ≤ 2.5 m·s⁻¹
      this.velocities[i3] = THREE.MathUtils.clamp(this.velocities[i3], -5.0, 5.0);
      this.velocities[i3 + 1] = THREE.MathUtils.clamp(
        this.velocities[i3 + 1],
        -2.5,
        1.0
      );
      this.velocities[i3 + 2] = THREE.MathUtils.clamp(this.velocities[i3 + 2], -5.0, 5.0);

      // Integrate position (m) and orientation (rad)
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;

      this.rotations[i3] += this.rotVelocities[i3] * dt;
      this.rotations[i3 + 1] += this.rotVelocities[i3 + 1] * dt;
      this.rotations[i3 + 2] += this.rotVelocities[i3 + 2] * dt;

      const gy = this.heightAt(this.positions[i3], this.positions[i3 + 2]);
      if (this.positions[i3 + 1] <= gy) {
        this._settleOnGround(i, dt, gy);
      }

      this._writeInstance(i);
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this._centerAttr.needsUpdate = true;
  }

  dispose() {
    this.instancedMesh.removeFromParent();
    if (this._ownsGeometry) this.geometry?.dispose();
    if (this._ownsMaterial && this.material && !this.material.userData?.shared) {
      this.material.dispose();
    }
  }
}
