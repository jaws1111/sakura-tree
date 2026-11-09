/**
 * Stratified / jittered crown sampling with local density control.
 * Prefer even spatial coverage (blue-noise-ish) over naive rejection sampling
 * so fewer instances still fill the crown silhouette.
 */

/**
 * Jittered grid samples inside a vase crown envelope, then thin by target count.
 * @param {number} targetCount
 * @param {object} envelope { y0, y1, radiusFn(t) }
 * @param {() => number} rng
 * @returns {{x:number,y:number,z:number}[]}
 */
export function sampleCrownStratified(targetCount, envelope, rng) {
  const { y0, y1, radiusFn } = envelope;
  const n = Math.max(1, targetCount);
  // Slight oversample then shuffle-thin for more even fill
  const over = Math.ceil(n * 1.35);
  const side = Math.ceil(Math.cbrt(over));
  const pts = [];

  for (let iz = 0; iz < side; iz++) {
    for (let iy = 0; iy < side; iy++) {
      for (let ix = 0; ix < side; ix++) {
        const u = (ix + rng()) / side;
        const v = (iy + rng()) / side;
        const w = (iz + rng()) / side;
        const y = y0 + v * (y1 - y0);
        const t = (y - y0) / Math.max(1e-6, y1 - y0);
        const rMax = radiusFn(t);
        // Disk sample via sqrt for area uniformity
        const r = Math.sqrt(u) * rMax;
        const theta = w * Math.PI * 2;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        if (x * x + z * z <= rMax * rMax * 1.02) {
          pts.push({ x, y, z, key: rng() });
        }
      }
    }
  }

  pts.sort((a, b) => a.key - b.key);
  return pts.slice(0, n).map(({ x, y, z }) => ({ x, y, z }));
}
