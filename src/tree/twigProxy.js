/**
 * Thin twigs are skipped by Marching Cubes (r < ~1.5·voxel).
 * One InstancedMesh of tubes keeps lean shoots visible for foliage readout.
 */
import * as THREE from 'three';

/**
 * @param {import('./skeleton.js').Skeleton} skeleton
 * @param {number} voxelM
 * @returns {THREE.Group|null}
 */
export function buildTwigProxyGroup(skeleton, voxelM = 0.065) {
  if (!skeleton?.edges?.length) return null;
  const maxR = Math.max(0.012, voxelM * 1.55);
  const thin = skeleton.edges.filter(
    (e) => !e.isRoot && Math.max(e.ra, e.rb) < maxR
  );
  if (!thin.length) return null;

  const group = new THREE.Group();
  group.name = 'TwigProxy';

  const geo = new THREE.CylinderGeometry(1, 1, 1, 4, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3a2a28,
    roughness: 0.92,
    metalness: 0.02
  });
  const mesh = new THREE.InstancedMesh(geo, mat, thin.length);
  mesh.castShadow = true;
  mesh.name = 'TwigProxyInstances';

  const dummy = new THREE.Object3D();
  const yUp = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();

  let written = 0;
  for (const e of thin) {
    dir.set(e.pb.x - e.pa.x, e.pb.y - e.pa.y, e.pb.z - e.pa.z);
    const L = dir.length();
    if (L < 1e-4) continue;
    dir.multiplyScalar(1 / L);
    const r = Math.max(0.0028, (e.ra + e.rb) * 0.5);
    dummy.position.set(
      (e.pa.x + e.pb.x) * 0.5,
      (e.pa.y + e.pb.y) * 0.5,
      (e.pa.z + e.pb.z) * 0.5
    );
    dummy.quaternion.setFromUnitVectors(yUp, dir);
    dummy.scale.set(r, L, r);
    dummy.updateMatrix();
    mesh.setMatrixAt(written++, dummy.matrix);
  }
  mesh.count = written;
  mesh.instanceMatrix.needsUpdate = true;

  group.add(mesh);
  group.userData.twigCount = written;
  group.userData.dispose = () => {
    geo.dispose();
    mat.dispose();
  };
  return group;
}
