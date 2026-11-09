/**
 * Vertex clustering mesh simplification (Lindstrom / Rossignac-style).
 *
 * After Marching Cubes, many triangles sample a smooth SDF at finer than
 * shading needs. Clustering vertices into cells of size `cellM` and rebuilding
 * an indexed mesh removes coplanar / sub-voxel redundancy while preserving
 * the isosurface topology at that scale (Nyquist of the display mesh).
 *
 * References:
 *  - Rossignac & Borrel, "Multi-resolution 3D approximations" (1993)
 *  - Lindstrom, "Out-of-core simplification of large polygonal models" (2000)
 */

/**
 * @param {Float32Array} positions
 * @param {Float32Array} normals
 * @param {Float32Array} [uvs]
 * @param {Uint32Array|Uint16Array} indices
 * @param {number} cellM cluster cell size in metres
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array|null, indices: Uint32Array, stats: object }}
 */
export function simplifyVertexClustering(positions, normals, uvs, indices, cellM) {
  const cell = Math.max(cellM, 1e-4);
  const inv = 1 / cell;
  const vCount = positions.length / 3;

  /** @type {Map<string, { sx:number,sy:number,sz:number, nx:number,ny:number,nz:number, ux:number,uy:number, n:number, id:number }>} */
  const clusters = new Map();
  const vertToCluster = new Int32Array(vCount);

  let nextId = 0;
  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cx = Math.floor(x * inv);
    const cy = Math.floor(y * inv);
    const cz = Math.floor(z * inv);
    const key = `${cx},${cy},${cz}`;
    let c = clusters.get(key);
    if (!c) {
      c = {
        sx: 0,
        sy: 0,
        sz: 0,
        nx: 0,
        ny: 0,
        nz: 0,
        ux: 0,
        uy: 0,
        n: 0,
        id: nextId++
      };
      clusters.set(key, c);
    }
    c.sx += x;
    c.sy += y;
    c.sz += z;
    c.nx += normals[i * 3];
    c.ny += normals[i * 3 + 1];
    c.nz += normals[i * 3 + 2];
    if (uvs) {
      c.ux += uvs[i * 2];
      c.uy += uvs[i * 2 + 1];
    }
    c.n += 1;
    vertToCluster[i] = c.id;
  }

  const outPos = new Float32Array(nextId * 3);
  const outNor = new Float32Array(nextId * 3);
  const outUv = uvs ? new Float32Array(nextId * 2) : null;

  for (const c of clusters.values()) {
    const id = c.id;
    const invN = 1 / c.n;
    outPos[id * 3] = c.sx * invN;
    outPos[id * 3 + 1] = c.sy * invN;
    outPos[id * 3 + 2] = c.sz * invN;
    let nx = c.nx;
    let ny = c.ny;
    let nz = c.nz;
    const len = Math.hypot(nx, ny, nz) || 1;
    outNor[id * 3] = nx / len;
    outNor[id * 3 + 1] = ny / len;
    outNor[id * 3 + 2] = nz / len;
    if (outUv) {
      outUv[id * 2] = c.ux * invN;
      outUv[id * 2 + 1] = c.uy * invN;
    }
  }

  // Remap triangles; drop degenerates (two corners in same cluster)
  const outIdx = [];
  const triBefore = indices.length / 3;
  for (let t = 0; t < indices.length; t += 3) {
    const a = vertToCluster[indices[t]];
    const b = vertToCluster[indices[t + 1]];
    const c = vertToCluster[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    outIdx.push(a, b, c);
  }

  return {
    positions: outPos,
    normals: outNor,
    uvs: outUv,
    indices: new Uint32Array(outIdx),
    stats: {
      cellM: cell,
      verticesBefore: vCount,
      verticesAfter: nextId,
      trianglesBefore: triBefore,
      trianglesAfter: outIdx.length / 3,
      reduction:
        triBefore > 0 ? 1 - outIdx.length / 3 / triBefore : 0
    }
  };
}
