import * as THREE from 'three';
import {
  TREE_HEIGHT_M,
  CROWN_RADIUS_M,
  Y_FORK_M,
  CLUSTER_SPAN_M
} from '../units.js';
import { PLAYABLE } from '../budget.js';
import { isScreenRelevant } from '../optimize/screenSpace.js';
import { ParametricPetalBuilder } from './ParametricPetalBuilder.js';
import { SakuraMaterialFactory } from './SakuraMaterialFactory.js';

/** Hard ceiling for slider / InstancedMesh capacity (2 million). */
export const CANOPY_COUNT_MAX = 2_000_000;
export const CANOPY_COUNT_MIN = 100;
export const BLOSSOM_SIZE_MIN = 0.25;
export const BLOSSOM_SIZE_MAX = 2.5;
export const PEDUNCLE_SCALE_MIN = 0.15;
export const PEDUNCLE_SCALE_MAX = 3.5;

/**
 * Dense lite-LOD canopy. Blossoms only on thinnest aerial twigs — never floating.
 */
export class CanopyInstancer {
  constructor(
    scene,
    {
      count = PLAYABLE.canopyCount,
      seed = 42,
      material = null,
      quality = 'lite',
      sizeScale = 1,
      peduncleScale = 1
    } = {}
  ) {
    this.scene = scene;
    this.count = THREE.MathUtils.clamp(Math.floor(count), CANOPY_COUNT_MIN, CANOPY_COUNT_MAX);
    this.sizeScale = THREE.MathUtils.clamp(sizeScale, BLOSSOM_SIZE_MIN, BLOSSOM_SIZE_MAX);
    this.peduncleScale = THREE.MathUtils.clamp(
      peduncleScale,
      PEDUNCLE_SCALE_MIN,
      PEDUNCLE_SCALE_MAX
    );
    // Allocate lazily; start with a practical buffer, grow on setCount if needed
    this.capacity = Math.min(CANOPY_COUNT_MAX, Math.max(this.count, 32_768));
    this.seed = seed;
    this.quality = quality === 'high' ? 'high' : quality === 'playable' ? 'playable' : 'lite';
    this._skeleton = null;
    this._centers = null;
    this._phases = null;
    this._matrices = null;
    this._order = null;
    /** Wood attach seats (xyz) for falling-petal spawns — Float32Array|null */
    this.attachPoints = null;
    // On by default so blossoms shade each other (toggle in Blossom render)
    this.castShadow = true;
    this.receiveShadow = true;

    this.geoNear = ParametricPetalBuilder.createBlossomClusterGeometry({
      seed,
      quality: 'lite',
      kanzan: true,
      flowers: 1,
      buds: 0,
      petalsPerFlower: PLAYABLE.petalsPerFlower ?? 16,
      layers: 2,
      segmentsU: PLAYABLE.petalSegmentsU,
      segmentsV: PLAYABLE.petalSegmentsV,
      includeStamen: false
    });
    this.geoFar = ParametricPetalBuilder.createBlossomClusterGeometry({
      seed: seed + 1,
      quality: 'lite',
      kanzan: true,
      flowers: 1,
      buds: 0,
      petalsPerFlower: 10,
      layers: 2,
      segmentsU: 2,
      segmentsV: 2,
      includeStamen: false
    });

    this.material = material ?? SakuraMaterialFactory.createBlossomMaterial();
    this.meshNear = new THREE.InstancedMesh(this.geoNear, this.material, this.capacity);
    this.meshFar = new THREE.InstancedMesh(this.geoFar, this.material, this.capacity);
    for (const m of [this.meshNear, this.meshFar]) {
      m.castShadow = this.castShadow;
      m.receiveShadow = this.receiveShadow;
      m.frustumCulled = true;
    }
    this.meshNear.name = 'sakura-canopy-lod0';
    this.meshFar.name = 'sakura-canopy-lod1';
    this.mesh = this.meshNear;

    this.#placeInstances();
    scene.add(this.meshNear);
    scene.add(this.meshFar);
  }

  /**
   * Grow InstancedMesh capacity (up to 2M) when the slider exceeds current buffer.
   * @param {number} need
   */
  #ensureCapacity(need) {
    const want = Math.min(CANOPY_COUNT_MAX, Math.max(need, this.capacity));
    if (want <= this.capacity && this.meshNear && this.meshFar) return;
    const oldNear = this.meshNear;
    const oldFar = this.meshFar;
    this.capacity = want;
    this.meshNear = new THREE.InstancedMesh(this.geoNear, this.material, this.capacity);
    this.meshFar = new THREE.InstancedMesh(this.geoFar, this.material, this.capacity);
    for (const m of [this.meshNear, this.meshFar]) {
      m.castShadow = this.castShadow;
      m.receiveShadow = this.receiveShadow;
      m.frustumCulled = true;
    }
    this.meshNear.name = 'sakura-canopy-lod0';
    this.meshFar.name = 'sakura-canopy-lod1';
    this.mesh = this.meshNear;
    // Don't dispose — geometries/material are shared with the new meshes
    if (oldNear) this.scene.remove(oldNear);
    if (oldFar) this.scene.remove(oldFar);
    this.scene.add(this.meshNear);
    this.scene.add(this.meshFar);
  }

  /**
   * Live-adjust blossom instance count (slider). Branch-only rebind.
   * @param {number} n
   */
  setCount(n) {
    const target = THREE.MathUtils.clamp(Math.floor(n), CANOPY_COUNT_MIN, CANOPY_COUNT_MAX);
    this.#ensureCapacity(target);
    this.count = target;
    this.#placeInstances(this._skeleton);
    this.#repartition(null);
    return this.count;
  }

  /**
   * Live-adjust blossom cluster size. Redistributes on twigs (packing scales with size).
   * @param {number} s  relative scale (1 = default CLUSTER_SPAN)
   */
  setSize(s) {
    this.sizeScale = THREE.MathUtils.clamp(Number(s) || 1, BLOSSOM_SIZE_MIN, BLOSSOM_SIZE_MAX);
    this.#placeInstances(this._skeleton);
    this.#repartition(null);
    return this.sizeScale;
  }

  /**
   * Live-adjust peduncle (attachment twig) length. Redistributes pocket volume.
   * @param {number} s
   */
  setPeduncleScale(s) {
    this.peduncleScale = THREE.MathUtils.clamp(
      Number(s) || 1,
      PEDUNCLE_SCALE_MIN,
      PEDUNCLE_SCALE_MAX
    );
    this.#placeInstances(this._skeleton);
    this.#repartition(null);
    return this.peduncleScale;
  }

  /**
   * Blossom render / lighting knobs (live — no redistribute).
   * @param {object} opts
   */
  setRenderOptions(opts = {}) {
    if (opts.castShadow != null) {
      this.castShadow = Boolean(opts.castShadow);
      if (this.meshNear) this.meshNear.castShadow = this.castShadow;
      if (this.meshFar) this.meshFar.castShadow = this.castShadow;
    }
    if (opts.receiveShadow != null) {
      this.receiveShadow = Boolean(opts.receiveShadow);
      if (this.meshNear) this.meshNear.receiveShadow = this.receiveShadow;
      if (this.meshFar) this.meshFar.receiveShadow = this.receiveShadow;
    }
    const mat = this.material;
    if (!mat) return;
    if (opts.emissiveIntensity != null) {
      mat.emissiveIntensity = THREE.MathUtils.clamp(opts.emissiveIntensity, 0, 1.5);
    }
    if (opts.opacity != null) {
      mat.opacity = THREE.MathUtils.clamp(opts.opacity, 0.15, 1);
      mat.transparent = true;
    }
    if (opts.roughness != null) {
      mat.roughness = THREE.MathUtils.clamp(opts.roughness, 0.05, 1);
    }
    const u = mat.userData?.uniforms;
    if (u && opts.brightBoost != null) {
      u.uBrightBoost.value = THREE.MathUtils.clamp(opts.brightBoost, 0, 1.5);
    }
    if (u && opts.edgeFade != null) {
      u.uEdgeFade.value = THREE.MathUtils.clamp(opts.edgeFade, 0, 1);
    }
    if (opts.primaryColor != null) {
      mat.color.set(opts.primaryColor);
    }
    if (opts.centerColor != null && u?.uPetalCore) {
      u.uPetalCore.value.set(opts.centerColor);
    }
    if (opts.emissiveColor != null && mat.emissive) {
      mat.emissive.set(opts.emissiveColor);
    }
    mat.needsUpdate = true;
  }

  /**
   * @param {string|number|THREE.Color} primary  lamina / body color
   * @param {string|number|THREE.Color} [center] petal core color
   */
  setColors(primary, center) {
    this.setRenderOptions({
      primaryColor: primary,
      centerColor: center ?? primary
    });
  }

  /** Fork height used for aerial filters (from last skeleton). */
  #forkY() {
    return this._skeleton?.forkYM ?? Y_FORK_M;
  }

  /**
   * Grow a short peduncle (attachment twig) from a bark seat so blossoms
   * form volume pockets instead of stacking flush on the wood.
   * @returns {{ x:number,y:number,z:number,tx:number,ty:number,tz:number,stem:number,pri:number }}
   */
  #peduncleFromSeat(ax, ay, az, nx, ny, nz, tx, ty, tz, rand, priBoost = 0) {
    const sz = this.sizeScale || 1;
    const ped = this.peduncleScale || 1;
    // Varying stem length — short buds vs longer pocket shoots
    const stemMin = 0.012 * sz * ped;
    const stemMax = 0.095 * sz * ped;
    const stem = stemMin + rand() * rand() * (stemMax - stemMin); // bias shorter, allow long outliers
    // Fan around bark outward + mild tipward lift + slight droop
    const twist = (rand() - 0.5) * Math.PI;
    const ca = Math.cos(twist);
    const sa = Math.sin(twist);
    // Orthonormalize a ring basis from (n, t)
    let bx = ny * tz - nz * ty;
    let by = nz * tx - nx * tz;
    let bz = nx * ty - ny * tx;
    let bLen = Math.hypot(bx, by, bz);
    if (bLen < 1e-6) {
      bx = -tz;
      by = 0;
      bz = tx;
      bLen = Math.hypot(bx, by, bz) || 1;
    }
    bx /= bLen;
    by /= bLen;
    bz /= bLen;
    // Outward on bark ring, then lean toward tip + soft gravity
    let sx = nx * ca + bx * sa;
    let sy = ny * ca + by * sa;
    let szY = nz * ca + bz * sa;
    const tipLean = 0.25 + rand() * 0.55;
    sx += tx * tipLean;
    sy += ty * tipLean - (0.08 + rand() * 0.22); // slight droop
    szY += tz * tipLean;
    const sLen = Math.hypot(sx, sy, szY) || 1;
    sx /= sLen;
    sy /= sLen;
    szY /= sLen;
    return {
      x: ax + sx * stem,
      y: ay + sy * stem,
      z: az + szY * stem,
      tx: sx,
      ty: sy,
      tz: szY,
      stem,
      ax,
      ay,
      az,
      pri: priBoost + stem * 8 + rand()
    };
  }

  /**
   * Candidates ONLY from thinnest aerial wood — each seat sprouts several
   * attachment twigs of varying length (blossom pockets / nodes).
   * @param {import('../tree/skeleton.js').Skeleton|null} skeleton
   * @param {() => number} rand
   * @param {number} minDist
   */
  #candidateTwigAnchors(skeleton, rand, minDist) {
    const pts = [];
    if (!skeleton?.edges?.length) return pts;
    // Sample seats along thin shoots denser than blossom packing
    const step = Math.max(0.02, minDist * 0.7);
    const thin = skeleton.edges.filter((e) => {
      if (e.isRoot) return false;
      const rMin = Math.min(e.ra, e.rb);
      const rMax = Math.max(e.ra, e.rb);
      if (rMin > 0.012) return false;
      if (rMax > 0.05) return false;
      const y = (e.pa.y + e.pb.y) * 0.5;
      return y > this.#forkY() * 0.95;
    });
    for (let i = thin.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = thin[i];
      thin[i] = thin[j];
      thin[j] = tmp;
    }
    // How many peduncles fan from each wood seat (volume pocket)
    const pocketN = minDist < 0.028 ? 5 : minDist < 0.04 ? 4 : 3;
    const edgeStride = thin.length > 20_000 ? Math.ceil(thin.length / 12_000) : 1;
    for (let ei = 0; ei < thin.length; ei += edgeStride) {
      const e = thin[ei];
      const dx = e.pb.x - e.pa.x;
      const dy = e.pb.y - e.pa.y;
      const dz = e.pb.z - e.pa.z;
      const L = Math.hypot(dx, dy, dz);
      if (L < step * 0.35) continue;
      const nSeg = Math.max(1, Math.floor(L / step));
      const phase = rand() * 0.4;
      const rAvg = (e.ra + e.rb) * 0.5;
      const len = L || 1;
      const tx = dx / len;
      const ty = dy / len;
      const tz = dz / len;
      let ux = -dz / len;
      let uz = dx / len;
      const uLen = Math.hypot(ux, uz) || 1;
      ux /= uLen;
      uz /= uLen;
      let vx = dy * uz;
      let vy = dz * ux - dx * uz;
      let vz = -dy * ux;
      const vLen = Math.hypot(vx, vy, vz) || 1;
      vx /= vLen;
      vy /= vLen;
      vz /= vLen;
      for (let s = 0; s <= nSeg; s++) {
        const t = Math.min(0.94, Math.max(0.06, (s + phase) / (nSeg + 1)));
        const px = e.pa.x + dx * t;
        const py = e.pa.y + dy * t;
        const pz = e.pa.z + dz * t;
        const rLocal = e.ra + (e.rb - e.ra) * t;
        // Bark seat + several attachment twigs of varying length around the ring
        for (let r = 0; r < pocketN; r++) {
          const ang = ((r + rand() * 0.4) / pocketN) * Math.PI * 2;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const nx = ux * ca + vx * sa;
          const ny = vy * sa;
          const nz = uz * ca + vz * sa;
          const seat = rLocal + 0.003;
          const ax = px + nx * seat;
          const ay = py + ny * seat;
          const az = pz + nz * seat;
          pts.push(
            this.#peduncleFromSeat(
              ax,
              ay,
              az,
              nx,
              ny,
              nz,
              tx,
              ty,
              tz,
              rand,
              2 + (0.014 - rAvg) * 40
            )
          );
        }
      }
    }
    return pts;
  }

  /**
   * Poisson-disk accept into a hash grid — maximizes coverage, kills wasteful overlap.
   * @param {object[]} candidates
   * @param {number} want
   * @param {number} minDist
   */
  #poissonSelect(candidates, want, minDist) {
    const cell = Math.max(1e-4, minDist);
    const inv = 1 / cell;
    /** @type {Map<string, number[]>} */
    const grid = new Map();
    const accepted = [];
    const minDist2 = minDist * minDist;

    const keyOf = (x, y, z) =>
      `${Math.floor(x * inv)},${Math.floor(y * inv)},${Math.floor(z * inv)}`;

    const farEnough = (x, y, z) => {
      const ix = Math.floor(x * inv);
      const iy = Math.floor(y * inv);
      const iz = Math.floor(z * inv);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
            if (!bucket) continue;
            for (const ai of bucket) {
              const a = accepted[ai];
              const d2 =
                (a.x - x) * (a.x - x) +
                (a.y - y) * (a.y - y) +
                (a.z - z) * (a.z - z);
              if (d2 < minDist2) return false;
            }
          }
        }
      }
      return true;
    };

    // Prefer higher-priority candidates (tips first if marked)
    const ordered = candidates.slice().sort((a, b) => (b.pri ?? 0) - (a.pri ?? 0));
    for (const c of ordered) {
      if (accepted.length >= want) break;
      if (!farEnough(c.x, c.y, c.z)) continue;
      const id = accepted.length;
      accepted.push(c);
      const k = keyOf(c.x, c.y, c.z);
      const bucket = grid.get(k);
      if (bucket) bucket.push(id);
      else grid.set(k, [id]);
    }
    return accepted;
  }

  /**
   * Adaptive min separation from crown volume + instance count.
   * Higher count → slightly tighter pack, but never stack on top of each other.
   */
  #minBlossomDist(count) {
    const h = Math.max(0.5, TREE_HEIGHT_M - this.#forkY());
    const vol = Math.PI * CROWN_RADIUS_M * CROWN_RADIUS_M * h * 0.5;
    const ideal = Math.cbrt(vol / Math.max(1, count));
    const sz = this.sizeScale || 1;
    const clusterR = CLUSTER_SPAN_M * 0.4 * sz;
    // High counts pack tighter along thin twigs; floor keeps clusters from nesting
    let lo = clusterR * 0.75;
    if (count >= 20_000) lo = clusterR * 0.5;
    if (count >= 100_000) lo = clusterR * 0.32;
    if (count >= 500_000) lo = clusterR * 0.22;
    const hi = clusterR * 1.7;
    return THREE.MathUtils.clamp(ideal * 0.85 * sz, lo, hi);
  }

  #rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Collect blossom anchors from lean aerial tips / twigs.
   * @param {import('../tree/skeleton.js').Skeleton|null} skeleton
   */
  /** Thinnest aerial tips / twigs only (r ≤ 12 mm). */
  #collectTips(skeleton) {
    const tips = [];
    if (!skeleton?.nodes) return tips;
    for (const n of skeleton.nodes) {
      if (n.kind === 'root' || n.kind === 'taproot' || n.kind === 'collar') continue;
      if (n.kind === 'trunk') continue;
      if (n.position.y < this.#forkY() * 0.95) continue;
      if (n.radius > 0.012) continue;
      const leaf = !n.children?.length;
      const twig = n.kind === 'twig';
      if (leaf || twig) tips.push(n);
    }
    tips.sort((a, b) => a.radius - b.radius);
    return tips;
  }

  /**
   * @param {import('../tree/skeleton.js').Skeleton|null} [skeleton]
   */
  #placeInstances(skeleton = null) {
    if (skeleton) this._skeleton = skeleton;
    const sk = skeleton ?? this._skeleton;
    const target = this.count; // requested (slider) — never zero just because bake is pending
    if (!sk?.nodes?.length) {
      this.placed = 0;
      if (this.meshNear) this.meshNear.count = 0;
      if (this.meshFar) this.meshFar.count = 0;
      return;
    }

    const rand = this.#rng(this.seed);
    const tips = this.#collectTips(sk);
    const minDist = this.#minBlossomDist(target);

    // Wood seats + varying-length attachment twigs (volume pockets, not bark stacks)
    const candidates = [];
    for (let i = tips.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = tips[i];
      tips[i] = tips[j];
      tips[j] = tmp;
    }
    // Tip seats: several attachment twigs of varying length → blossom pockets at tips
    const tipPockets = minDist < 0.03 ? 5 : 3;
    for (const n of tips) {
      const T = n.T || { x: 0, y: 1, z: 0 };
      const tLen = Math.hypot(T.x, T.y, T.z) || 1;
      const tx = T.x / tLen;
      const ty = T.y / tLen;
      const tz = T.z / tLen;
      // Stable radial basis perpendicular to tip tangent
      let rx = -tz;
      let rz = tx;
      let rLen = Math.hypot(rx, rz);
      if (rLen < 1e-6) {
        rx = 1;
        rz = 0;
        rLen = 1;
      }
      rx /= rLen;
      rz /= rLen;
      // Second axis = T × r
      let ux = ty * rz - tz * 0;
      let uy = tz * rx - tx * rz;
      let uz = tx * 0 - ty * rx;
      const uLen = Math.hypot(ux, uy, uz) || 1;
      ux /= uLen;
      uy /= uLen;
      uz /= uLen;
      for (let k = 0; k < tipPockets; k++) {
        const ang = ((k + rand() * 0.35) / tipPockets) * Math.PI * 2;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        let onx = rx * ca + ux * sa;
        let ony = 0 * ca + uy * sa;
        let onz = rz * ca + uz * sa;
        const oLen = Math.hypot(onx, ony, onz) || 1;
        onx /= oLen;
        ony /= oLen;
        onz /= oLen;
        const seat = n.radius + 0.003;
        candidates.push(
          this.#peduncleFromSeat(
            n.position.x + onx * seat,
            n.position.y + ony * seat,
            n.position.z + onz * seat,
            onx,
            ony,
            onz,
            tx,
            ty,
            tz,
            rand,
            5 + (0.012 - n.radius) * 50
          )
        );
      }
    }
    const twigAnchors = this.#candidateTwigAnchors(sk, rand, minDist);
    for (let i = 0; i < twigAnchors.length; i++) candidates.push(twigAnchors[i]);

    let pts = this.#poissonSelect(candidates, target, minDist);
    if (pts.length < target * 0.9) {
      pts = this.#poissonSelect(candidates, target, minDist * 0.65);
    }
    if (pts.length < target * 0.9) {
      pts = this.#poissonSelect(candidates, target, minDist * 0.4);
    }
    if (pts.length < target * 0.85) {
      // Tighter pack in pocket volume — still only peduncle-tethered candidates
      pts = this.#poissonSelect(candidates, target, Math.max(0.01, minDist * 0.22));
    }
    // Only peduncle tips from thin-wood seats — no free crown cloud
    const placed = pts.length;
    this.placed = placed;
    if (placed === 0) {
      this.meshNear.count = 0;
      this.meshFar.count = 0;
      this._centers = new Float32Array(0);
      this._phases = new Float32Array(0);
      this._matrices = [];
      this._order = [];
      this.attachPoints = new Float32Array(0);
      return;
    }

    const dummy = new THREE.Object3D();
    this._centers = new Float32Array(placed * 3);
    this._phases = new Float32Array(placed);
    this.attachPoints = new Float32Array(placed * 3);
    this._matrices = [];
    this._order = new Array(placed);

    for (let i = 0; i < placed; i++) {
      const p = pts[i];
      dummy.position.set(p.x, p.y, p.z);
      // Size slider drives cluster scale; packing minDist already tracks sizeScale
      const sz = this.sizeScale || 1;
      const sMax = Math.min(1.15 * sz, (minDist / (CLUSTER_SPAN_M * 0.5)) * 0.85);
      dummy.scale.setScalar((0.7 + rand() * 0.25) * sMax);
      if (p.tx != null) {
        const tang = new THREE.Vector3(p.tx, p.ty, p.tz);
        if (tang.lengthSq() < 1e-8) tang.set(0, 1, 0);
        else tang.normalize();
        dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tang);
        dummy.rotateY(rand() * Math.PI * 2);
        dummy.rotateX((rand() - 0.5) * 0.4);
      } else {
        dummy.rotation.set(
          (rand() - 0.5) * 0.55,
          rand() * Math.PI * 2,
          (rand() - 0.5) * 0.55
        );
      }
      dummy.updateMatrix();
      this._matrices.push(dummy.matrix.clone());
      this._centers[i * 3] = p.x;
      this._centers[i * 3 + 1] = p.y;
      this._centers[i * 3 + 2] = p.z;
      // Wood seat (peduncle root) — falling petals spawn from these
      this.attachPoints[i * 3] = p.ax ?? p.x;
      this.attachPoints[i * 3 + 1] = p.ay ?? p.y;
      this.attachPoints[i * 3 + 2] = p.az ?? p.z;
      this._phases[i] = rand() * Math.PI * 2;
      this._order[i] = i;
    }

    const bindAttrs = (geom) => {
      geom.setAttribute(
        'aClusterCenter',
        new THREE.InstancedBufferAttribute(this._centers.slice(), 3)
      );
      geom.setAttribute(
        'aInstancePhase',
        new THREE.InstancedBufferAttribute(this._phases.slice(), 1)
      );
    };
    bindAttrs(this.geoNear);
    bindAttrs(this.geoFar);

    const pad = 0.5;
    const forkY = this.#forkY();
    const sphere = new THREE.Sphere(
      new THREE.Vector3(0, (forkY + TREE_HEIGHT_M) * 0.5, 0),
      CROWN_RADIUS_M + pad + 1.0
    );
    this.meshNear.boundingSphere = sphere.clone();
    this.meshFar.boundingSphere = sphere.clone();
    this.#repartition(null);
  }

  #repartition(camera) {
    const nearMats = [];
    const farMats = [];
    const nearCenters = [];
    const farCenters = [];
    const nearPhases = [];
    const farPhases = [];

    const lodNearM = 14;
    const lodFarM = 36;
    const n = this._matrices?.length ?? 0;

    for (let i = 0; i < n; i++) {
      const x = this._centers[i * 3];
      const y = this._centers[i * 3 + 1];
      const z = this._centers[i * 3 + 2];
      let dist = 10;
      if (camera) {
        dist = Math.hypot(
          x - camera.position.x,
          y - camera.position.y,
          z - camera.position.z
        );
        if (
          dist > lodFarM &&
          !isScreenRelevant(CLUSTER_SPAN_M, dist, camera, 1.1)
        ) {
          continue;
        }
      }

      if (!camera || dist < lodNearM) {
        nearMats.push(this._matrices[i]);
        nearCenters.push(x, y, z);
        nearPhases.push(this._phases[i]);
      } else {
        farMats.push(this._matrices[i]);
        farCenters.push(x, y, z);
        farPhases.push(this._phases[i]);
      }
    }

    this.#upload(this.meshNear, this.geoNear, nearMats, nearCenters, nearPhases);
    this.#upload(this.meshFar, this.geoFar, farMats, farCenters, farPhases);
  }

  #upload(mesh, geom, mats, centers, phases) {
    const n = mats.length;
    mesh.count = n;
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, mats[i]);
    mesh.instanceMatrix.needsUpdate = true;
    if (n > 0) {
      geom.setAttribute(
        'aClusterCenter',
        new THREE.InstancedBufferAttribute(new Float32Array(centers), 3)
      );
      geom.setAttribute(
        'aInstancePhase',
        new THREE.InstancedBufferAttribute(new Float32Array(phases), 1)
      );
    }
  }

  /** @param {import('../tree/skeleton.js').Skeleton|null} skeleton */
  rebindToSkeleton(skeleton) {
    this.#placeInstances(skeleton);
    this.#repartition(null);
  }

  /** @param {number} time @param {number} [windStrength] @param {THREE.Camera} [camera] */
  update(time, windStrength, camera) {
    SakuraMaterialFactory.updateBlossomMaterial(this.material, time, windStrength);
    if (camera) this.#repartition(camera);
  }

  dispose() {
    this.scene.remove(this.meshNear);
    this.scene.remove(this.meshFar);
    this.geoNear.dispose();
    this.geoFar.dispose();
    if (this.material && !this.material.userData?.shared) {
      this.material.dispose();
    }
  }
}
