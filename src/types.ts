/**
 * Domain types for camber-line definitions and thin-airfoil quantities.
 *
 * Every formula in this service takes the angle of attack alpha in
 * RADIANS. Degrees are never accepted into the aerodynamic kernels.
 */

/** Camber line given by polynomial coefficients in ascending powers:
 *  z(x) = c0 + c1*x + c2*x^2 + ...  (chord normalised to 1). */
export interface PolynomialCamber {
  kind: 'polynomial';
  coefficients: number[];
}

/** Camber line given by discrete (x, z) samples. Samples must be strictly
 *  increasing in x; the service linearly interpolates between them.
 *  `chord`, when supplied, gives the physical chord so the x values can be
 *  scaled onto [0, 1]. Without it x must already span [0, 1]. */
export interface PointCamber {
  kind: 'points';
  points: Array<{ x: number; z: number }>;
  chord?: number;
}

export type CamberDef = PolynomialCamber | PointCamber;

/**
 * A built camber line. The thin-airfoil integrals only ever need the
 * slope dz/dx as a function of the transformed angle theta, where
 *
 *     x(theta) = (1 - cos theta) / 2,   theta in [0, pi].
 *
 * `cosineMoment(m)` returns
 *
 *     M_m = (1/pi) * integral_0^pi (dz/dx)(theta) cos(m theta) d theta
 *
 * for m = 0, 1, 2, ... . Point-defined lines are integrated exactly per
 * linear segment; polynomial lines use high-resolution Simpson quadrature.
 */
export interface CamberModel {
  readonly def: CamberDef;
  slopeAt(x: number): number;
  cosineMoment(m: number): number;
  /** True when the line is the zero (symmetric) camber line. */
  isZero(): boolean;
}

/** Convert chord coordinate x in [0, 1] to the angle coordinate theta. */
export function xToTheta(x: number): number {
  // cos theta = 1 - 2x, which ranges over [-1, 1].
  const c = Math.min(1, Math.max(-1, 1 - 2 * x));
  return Math.acos(c);
}

/** Convert angle coordinate theta in [0, pi] back to chord coordinate x. */
export function thetaToX(theta: number): number {
  return (1 - Math.cos(theta)) / 2;
}
