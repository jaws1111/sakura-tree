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
export const BLOSSOM_SIZE_MAX = 3;
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

    // 5-leaf folded-plane blossoms (4 tris/leaf) — same mesh for near/far + falling
    this.geoNear = ParametricPetalBuilder.createFiveLeafBlossom({ seed });
    this.geoFar = ParametricPetalBuilder.createFiveLeafBlossom({
      seed: seed + 1,
      open: 1.05
    });
    // Placeholder instance attrs so the blossom shader compiles before first place
    for (const g of [this.geoNear, this.geoFar]) {
      g.setAttribute(
        'aClusterCenter',
        new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3)
      );
      g.setAttribute(
        'aInstancePhase',
        new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1)
      );
    }

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
    const u = mat.userData?.uniforms;
    if (opts.opacity != null) {
      const op = THREE.MathUtils.clamp(opts.opacity, 0.15, 1);
      mat.opacity = op;
      mat.transparent = true;
      if (u?.uOpacity) u.uOpacity.value = op;
    }
    if (opts.roughness != null) {
      mat.roughness = THREE.MathUtils.clamp(opts.roughness, 0.05, 1);
    }
    if (u && opts.brightBoost != null) {
      u.uBrightBoost.value = THREE.MathUtils.clamp(opts.brightBoost, 0, 1.5);
    }
    if (u && opts.aoStrength != null && u.uAOStrength) {
      u.uAOStrength.value = THREE.MathUtils.clamp(opts.aoStrength, 0, 1);
    }
    if (u && opts.edgeFade != null) {
      // GUI 0–1 → SDF soft-edge width (~0.01–0.12)
      const t = THREE.MathUtils.clamp(opts.edgeFade, 0, 1);
      u.uEdgeFade.value = 0.01 + t * 0.11;
    }
    if (opts.primaryColor != null) {
      const c = opts.primaryColor;
      mat.color?.set?.(c);
      u?.uColorPrimary?.value?.set?.(c);
      u?.uPetalRim?.value?.set?.(c);
    }
    if (opts.centerColor != null) {
      const c = opts.centerColor;
      mat.emissive?.set?.(c);
      u?.uColorCenter?.value?.set?.(c);
      u?.uPetalCore?.value?.set?.(c);
    }
    if (opts.emissiveIntensity != null && mat.emissiveIntensity != null) {
      mat.emissiveIntensity = THREE.MathUtils.clamp(opts.emissiveIntensity, 0, 1.5);
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
   * Spread seats along thin aerial wood (length-weighted) so 20–30k blossoms
   * can fill the crown without clustering only at tips.
   * @param {import('../tree/skeleton.js').Skeleton|null} skeleton
   * @param {() => number} rand
   * @param {number} minDist
   * @param {number} want
   */
  #candidateTwigAnchors(skeleton, rand, minDist, want = 12000) {
    const pts = [];
    if (!skeleton?.edges?.length) return pts;
    const forkY = this.#forkY();
    // Include lean shoots + thin-ended laterals (not only tip stubs)
    const thin = [];
    let totalLen = 0;
    for (let i = 0; i < skeleton.edges.length; i++) {
      const e = skeleton.edges[i];
      if (e.isRoot) continue;
      const rMin = Math.min(e.ra, e.rb);
      const rMax = Math.max(e.ra, e.rb);
      if (rMin > 0.016) continue;
      if (rMax > 0.055) continue;
      const y = (e.pa.y + e.pb.y) * 0.5;
      if (y < forkY * 0.9) continue;
      const L = Math.hypot(e.pb.x - e.pa.x, e.pb.y - e.pa.y, e.pb.z - e.pa.z);
      if (L < 0.012) continue;
      thin.push(e);
      totalLen += L;
    }
    if (!thin.length || totalLen < 1e-4) return pts;

    // Enough candidates for poisson fill; scale with want (was capped ~90k → >100k starved)
    const targetSeats = Math.max(want * 2.2, want + 1500);
    const step = Math.max(0.008, Math.min(0.06, totalLen / targetSeats));
    // Extra ring seats when packing dense / high counts
    const pocketN = want >= 80_000 || minDist < 0.03 ? 2 : 1;
    const maxPts = Math.min(
      1_200_000,
      Math.ceil(Math.max(targetSeats * pocketN * 1.15, want * 2.5))
    );

    for (let ei = 0; ei < thin.length; ei++) {
      if (pts.length >= maxPts) break;
      const e = thin[ei];
      const dx = e.pb.x - e.pa.x;
      const dy = e.pb.y - e.pa.y;
      const dz = e.pb.z - e.pa.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      const nSeg = Math.max(1, Math.floor(L / step));
      const phase = rand() * 0.55;
      const rAvg = (e.ra + e.rb) * 0.5;
      const tx = dx / L;
      const ty = dy / L;
      const tz = dz / L;
      let ux = -dz / L;
      let uz = dx / L;
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
      // Prefer mid-span seats (tips handled separately, lightly)
      for (let s = 0; s <= nSeg; s++) {
        if (pts.length >= maxPts) break;
        const t = Math.min(0.92, Math.max(0.08, (s + phase) / (nSeg + 1)));
        const px = e.pa.x + dx * t;
        const py = e.pa.y + dy * t;
        const pz = e.pa.z + dz * t;
        const rLocal = e.ra + (e.rb - e.ra) * t;
        for (let r = 0; r < pocketN; r++) {
          const ang = ((r + rand() * 0.5) / pocketN) * Math.PI * 2 + ei * 0.37;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const nx = ux * ca + vx * sa;
          const ny = vy * sa;
          const nz = uz * ca + vz * sa;
          const seat = rLocal + 0.003;
          // Mid-branch priority > tip so poisson fills length first
          const midBias = 1 - Math.abs(t - 0.5) * 1.2;
          pts.push(
            this.#peduncleFromSeat(
              px + nx * seat,
              py + ny * seat,
              pz + nz * seat,
              nx,
              ny,
              nz,
              tx,
              ty,
              tz,
              rand,
              6 + midBias * 8 + (0.016 - rAvg) * 30
            )
          );
        }
      }
    }
    return pts;
  }

  /**
   * Poisson-disk accept — shuffle for spread (no tip-first sort bias).
   * @param {object[]} candidates
   * @param {number} want
   * @param {number} minDist
   * @param {() => number} [rand]
   */
  #poissonSelect(candidates, want, minDist, rand = Math.random) {
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

    // Partial Fisher–Yates: only shuffle what we may scan (avoids O(n) when n ≫ want)
    const ordered = candidates;
    const scanN = Math.min(ordered.length, Math.max(want * 4, want + 4000));
    for (let i = 0; i < scanN; i++) {
      const j = i + Math.floor(rand() * (ordered.length - i));
      const tmp = ordered[i];
      ordered[i] = ordered[j];
      ordered[j] = tmp;
      // Soft mid-branch bias without window bubble sort
      if (i > 0 && (ordered[i].pri ?? 0) > (ordered[i - 1].pri ?? 0) && rand() > 0.55) {
        const t = ordered[i - 1];
        ordered[i - 1] = ordered[i];
        ordered[i] = t;
      }
    }

    for (let i = 0; i < scanN; i++) {
      const c = ordered[i];
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
   * Adaptive min separation for poisson packing only — must NOT drive visual scale.
   * (Tying instance scale to this made >100k look emptier: slider↑ → minDist↓ → blossoms shrink.)
   */
  #minBlossomDist(count) {
    const h = Math.max(0.5, TREE_HEIGHT_M - this.#forkY());
    const vol = Math.PI * CROWN_RADIUS_M * CROWN_RADIUS_M * h * 0.55;
    const ideal = Math.cbrt(vol / Math.max(1, count));
    const sz = this.sizeScale || 1;
    const clusterR = CLUSTER_SPAN_M * 0.38 * sz;
    let lo = clusterR * 0.55;
    if (count >= 12_000) lo = clusterR * 0.42;
    if (count >= 20_000) lo = clusterR * 0.32;
    if (count >= 30_000) lo = clusterR * 0.26;
    if (count >= 80_000) lo = clusterR * 0.18;
    if (count >= 200_000) lo = clusterR * 0.12;
    if (count >= 500_000) lo = clusterR * 0.08;
    const hi = clusterR * 1.5;
    return THREE.MathUtils.clamp(ideal * 0.9 * sz, lo, hi);
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

    // Primary: seats spread along thin branch length
    const candidates = this.#candidateTwigAnchors(sk, rand, minDist, target);

    // Light tip garnish only (avoid tip-clumping that left mid-branches bare)
    const tipCap = Math.min(tips.length, Math.max(80, Math.floor(target * 0.08)));
    for (let i = tips.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = tips[i];
      tips[i] = tips[j];
      tips[j] = tmp;
    }
    for (let ti = 0; ti < tipCap; ti++) {
      const n = tips[ti];
      const T = n.T || { x: 0, y: 1, z: 0 };
      const tLen = Math.hypot(T.x, T.y, T.z) || 1;
      const tx = T.x / tLen;
      const ty = T.y / tLen;
      const tz = T.z / tLen;
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
      let ux = ty * rz;
      let uy = tz * rx - tx * rz;
      let uz = -ty * rx;
      const uLen = Math.hypot(ux, uy, uz) || 1;
      ux /= uLen;
      uy /= uLen;
      uz /= uLen;
      const ang = rand() * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      let onx = rx * ca + ux * sa;
      let ony = uy * sa;
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
          2 + (0.012 - n.radius) * 20
        )
      );
    }

    // Adaptive single/double pass — avoid 4 full poisson scans
    let pts = this.#poissonSelect(candidates, target, minDist, rand);
    if (pts.length < target * 0.9) {
      pts = this.#poissonSelect(
        candidates,
        target,
        Math.max(0.01, minDist * (pts.length < target * 0.7 ? 0.35 : 0.55)),
        rand
      );
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
      // Visual size follows Blossom size only — do not shrink with canopy count / minDist
      const sz = this.sizeScale || 1;
      dummy.scale.setScalar((0.78 + rand() * 0.28) * sz);
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
    const lodFarM = 42;
    const n = this._matrices?.length ?? 0;
    // Screen cull uses actual blossom size so high count + large size still draws
    const screenDiam = CLUSTER_SPAN_M * Math.max(0.5, this.sizeScale || 1);

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
        if (dist > lodFarM && !isScreenRelevant(screenDiam, dist, camera, 0.85)) {
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
