/**
 * Screen-space / projected-size heuristics (Clark LOD, modern game practice).
 * Drop or downgrade geometry when it cannot contribute a visible pixel.
 */

/**
 * Approximate projected diameter in pixels.
 * @param {number} worldDiameterM
 * @param {number} distanceM
 * @param {number} fovYRad
 * @param {number} viewportHeightPx
 */
export function projectedDiameterPx(worldDiameterM, distanceM, fovYRad, viewportHeightPx) {
  const d = Math.max(distanceM, 1e-3);
  const worldHeightAtDist = 2 * d * Math.tan(fovYRad * 0.5);
  return (worldDiameterM / worldHeightAtDist) * viewportHeightPx;
}

/**
 * Keep detail if projected size ≥ minPx (Nyquist-ish for shading).
 * @param {number} worldDiameterM
 * @param {number} distanceM
 * @param {object} camera THREE.PerspectiveCamera-like
 * @param {number} [minPx=1.5]
 */
export function isScreenRelevant(worldDiameterM, distanceM, camera, minPx = 1.5) {
  const fov = (camera.fov * Math.PI) / 180;
  const h = camera.userData?.viewportH ?? (typeof window !== 'undefined' ? window.innerHeight : 900);
  return projectedDiameterPx(worldDiameterM, distanceM, fov, h) >= minPx;
}

/**
 * Exponential distance density (physically motivated falloff for foliage fill).
 * ρ(d) = exp(−max(0, d − d0) / λ)
 */
export function exponentialDensity(distanceM, d0, lambdaM) {
  const x = Math.max(0, distanceM - d0);
  return Math.exp(-x / Math.max(lambdaM, 1e-3));
}
