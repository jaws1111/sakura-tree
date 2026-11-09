/**
 * Visual analysis layers for skeleton / SDF / mesh debugging.
 */
import * as THREE from 'three';

const KIND_COLOR = {
  collar: 0xffee88,
  trunk: 0xc48a6a,
  branch: 0xe8a0b8,
  root: 0x5ec4b8,
  taproot: 0x2a9d8f
};

export class DebugOverlay {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'DebugOverlay';
    this.scene.add(this.root);

    this.layers = {
      skeleton: new THREE.Group(),
      nodes: new THREE.Group(),
      capsules: new THREE.Group(),
      frames: new THREE.Group(),
      bounds: new THREE.Group(),
      wireframe: new THREE.Group(),
      normals: new THREE.Group(),
      groundPlane: new THREE.Group()
    };
    for (const g of Object.values(this.layers)) {
      g.visible = false;
      this.root.add(g);
    }

    this._wireMesh = null;
    this._normalsHelper = null;
    this._state = {
      skeleton: false,
      nodes: false,
      capsules: false,
      frames: false,
      bounds: false,
      wireframe: false,
      normals: false,
      groundPlane: true,
      bark: true,
      canopy: true,
      grass: true,
      moss: true,
      petals: true,
      calRefs: true,
      showRoots: true,
      showShoots: true
    };

    this._buildGroundPlane();
  }

  _clear(group) {
    while (group.children.length) {
      const c = group.children.pop();
      c.geometry?.dispose?.();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose?.();
      }
    }
  }

  _buildGroundPlane() {
    const g = this.layers.groundPlane;
    this._clear(g);
    const grid = new THREE.GridHelper(20, 20, 0xaa6688, 0x664455);
    grid.position.y = 0.002;
    g.add(grid);
    const axes = new THREE.AxesHelper(2.5);
    axes.position.y = 0.01;
    g.add(axes);
    // y=0 collar plane
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff66aa,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    );
    plane.rotation.x = -Math.PI / 2;
    g.add(plane);
    g.visible = true;
  }

  /**
   * Rebuild skeleton-derived helpers from a Skeleton object.
   * @param {import('../tree/skeleton.js').Skeleton|null} skeleton
   */
  syncSkeleton(skeleton) {
    const { skeleton: skG, nodes, capsules, frames, bounds } = this.layers;
    this._clear(skG);
    this._clear(nodes);
    this._clear(capsules);
    this._clear(frames);
    this._clear(bounds);
    if (!skeleton) return;

    const shootPos = [];
    const rootPos = [];
    for (const e of skeleton.edges) {
      const arr = e.isRoot ? rootPos : shootPos;
      arr.push(e.pa.x, e.pa.y, e.pa.z, e.pb.x, e.pb.y, e.pb.z);
    }

    if (shootPos.length && this._state.showShoots) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(shootPos, 3));
      skG.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: 0xff9eb5, linewidth: 2 })
        )
      );
    }
    if (rootPos.length && this._state.showRoots) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(rootPos, 3));
      skG.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: 0x4ecdc4, linewidth: 2 })
        )
      );
    }

    // Nodes as spheres scaled by radius
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const n of skeleton.nodes) {
      if (n.kind === 'root' || n.kind === 'taproot') {
        if (!this._state.showRoots) continue;
      } else if (!this._state.showShoots && n.kind !== 'collar') {
        continue;
      }
      const r = Math.max(0.015, Math.min(n.radius * 0.85, 0.12));
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 8, 6),
        nodeMat.clone()
      );
      mesh.material.color.setHex(KIND_COLOR[n.kind] ?? 0xffffff);
      mesh.position.set(n.position.x, n.position.y, n.position.z);
      nodes.add(mesh);
    }

    // Capsule radius tubes (debug SDF thickness)
    for (const e of skeleton.edges) {
      if (e.isRoot && !this._state.showRoots) continue;
      if (!e.isRoot && !this._state.showShoots) continue;
      const ax = e.pb.x - e.pa.x;
      const ay = e.pb.y - e.pa.y;
      const az = e.pb.z - e.pa.z;
      const L = Math.hypot(ax, ay, az) || 1e-6;
      const rAvg = (e.ra + e.rb) * 0.5;
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(rAvg, rAvg, L, 6, 1, true),
        new THREE.MeshBasicMaterial({
          color: e.isRoot ? 0x2a9d8f : 0xc48a6a,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          side: THREE.DoubleSide,
          wireframe: false
        })
      );
      cyl.position.set(
        (e.pa.x + e.pb.x) * 0.5,
        (e.pa.y + e.pb.y) * 0.5,
        (e.pa.z + e.pb.z) * 0.5
      );
      cyl.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(ax / L, ay / L, az / L)
      );
      capsules.add(cyl);
    }

    // Parallel-transport frames at a subset of nodes
    let fi = 0;
    for (const n of skeleton.nodes) {
      if ((fi++ % 4) !== 0) continue;
      if ((n.kind === 'root' || n.kind === 'taproot') && !this._state.showRoots) continue;
      const o = new THREE.Vector3(n.position.x, n.position.y, n.position.z);
      const scale = Math.max(0.08, n.radius * 2.5);
      frames.add(this._axisLine(o, n.T, 0xff4444, scale));
      frames.add(this._axisLine(o, n.N, 0x44ff66, scale));
      frames.add(this._axisLine(o, n.B, 0x4488ff, scale));
    }

    // AABB
    const box = new THREE.Box3(
      new THREE.Vector3(skeleton.bounds.min.x, skeleton.bounds.min.y, skeleton.bounds.min.z),
      new THREE.Vector3(skeleton.bounds.max.x, skeleton.bounds.max.y, skeleton.bounds.max.z)
    );
    const helper = new THREE.Box3Helper(box, 0xffcc66);
    bounds.add(helper);
  }

  _axisLine(origin, dir, color, scale) {
    const d = dir || { x: 0, y: 1, z: 0 };
    const geo = new THREE.BufferGeometry().setFromPoints([
      origin.clone(),
      origin.clone().add(new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(scale))
    ]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
  }

  /**
   * Sync wireframe / normals from bark mesh.
   * @param {THREE.Mesh|null} barkMesh
   */
  syncBarkMesh(barkMesh) {
    const { wireframe, normals } = this.layers;
    this._clear(wireframe);
    this._clear(normals);
    this._wireMesh = null;
    this._normalsHelper = null;
    if (!barkMesh?.geometry) return;

    const mat = new THREE.MeshBasicMaterial({
      color: 0x9cf0ff,
      wireframe: true,
      transparent: true,
      opacity: 0.85,
      depthTest: true
    });
    this._wireMesh = new THREE.Mesh(barkMesh.geometry, mat);
    this._wireMesh.position.copy(barkMesh.position);
    this._wireMesh.quaternion.copy(barkMesh.quaternion);
    this._wireMesh.scale.copy(barkMesh.scale);
    wireframe.add(this._wireMesh);

    // Sparse normal ticks (every Nth vertex) — cheap substitute for VertexNormalsHelper
    const pos = barkMesh.geometry.getAttribute('position');
    const nrm = barkMesh.geometry.getAttribute('normal');
    if (pos && nrm) {
      const pts = [];
      const step = Math.max(1, Math.floor(pos.count / 2500));
      for (let i = 0; i < pos.count; i += step) {
        const ox = pos.getX(i);
        const oy = pos.getY(i);
        const oz = pos.getZ(i);
        const s = 0.08;
        pts.push(ox, oy, oz, ox + nrm.getX(i) * s, oy + nrm.getY(i) * s, oz + nrm.getZ(i) * s);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      normals.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: 0x88ffaa, transparent: true, opacity: 0.55 })
        )
      );
    }
  }

  /**
   * Apply visibility toggles to overlay + scene systems.
   * @param {object} engine
   * @param {object} [refs] { cal, human }
   */
  apply(engine, refs = {}) {
    const s = this._state;
    for (const [k, g] of Object.entries(this.layers)) {
      g.visible = Boolean(s[k]);
    }
    if (engine?.barkMesh) engine.barkMesh.visible = s.bark;
    if (engine?.twigProxy) engine.twigProxy.visible = s.bark;
    if (engine?.bole) engine.bole.visible = s.bark;
    if (engine?.canopy?.meshNear) engine.canopy.meshNear.visible = s.canopy;
    if (engine?.canopy?.meshFar) engine.canopy.meshFar.visible = s.canopy;
    else if (engine?.canopy?.mesh) engine.canopy.mesh.visible = s.canopy;
    if (engine?.grass?.group) engine.grass.group.visible = s.grass;
    if (engine?.moss?.group) engine.moss.group.visible = s.moss;
    if (engine?.barkMoss) engine.barkMoss.visible = s.moss;
    if (engine?.fallingPetals?.instancedMesh) {
      engine.fallingPetals.instancedMesh.visible = s.petals;
    }
    if (refs.cal) refs.cal.visible = s.calRefs;
    if (refs.human) refs.human.visible = s.calRefs;
  }

  set(key, value) {
    if (key in this._state) this._state[key] = value;
  }

  get state() {
    return this._state;
  }

  /**
   * Analysis presets.
   * @param {'beauty'|'skeleton'|'mesh'|'roots'|'full'} name
   * @param {object} engine
   * @param {object} refs
   */
  applyPreset(name, engine, refs) {
    const s = this._state;
    const allOff = () => {
      s.skeleton = false;
      s.nodes = false;
      s.capsules = false;
      s.frames = false;
      s.bounds = false;
      s.wireframe = false;
      s.normals = false;
      s.bark = true;
      s.canopy = true;
      s.grass = true;
      s.moss = true;
      s.petals = true;
      s.groundPlane = false;
    };
    allOff();
    if (name === 'beauty') {
      s.groundPlane = false;
    } else if (name === 'skeleton') {
      s.bark = false;
      s.canopy = false;
      s.grass = false;
      s.moss = false;
      s.petals = false;
      s.skeleton = true;
      s.nodes = true;
      s.bounds = true;
      s.groundPlane = true;
      s.calRefs = true;
    } else if (name === 'mesh') {
      s.canopy = false;
      s.grass = false;
      s.moss = false;
      s.petals = false;
      s.wireframe = true;
      s.normals = true;
      s.bounds = true;
      s.groundPlane = true;
    } else if (name === 'roots') {
      s.canopy = false;
      s.grass = false;
      s.moss = false;
      s.petals = false;
      s.skeleton = true;
      s.nodes = true;
      s.capsules = true;
      s.showRoots = true;
      s.showShoots = true;
      s.groundPlane = true;
    } else if (name === 'full') {
      s.skeleton = true;
      s.nodes = true;
      s.capsules = true;
      s.frames = true;
      s.bounds = true;
      s.wireframe = true;
      s.groundPlane = true;
      s.canopy = false;
      s.grass = false;
      s.moss = false;
      s.petals = false;
    }
    this.apply(engine, refs);
  }

  dispose() {
    for (const g of Object.values(this.layers)) this._clear(g);
    this.scene.remove(this.root);
  }
}
