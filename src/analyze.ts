/**
 * Thin-airfoil-theory aerodynamic kernel.
 *
 * Coordinate transform:
 *
 *     x = (1 - cos theta) / 2,   theta in [0, pi].
 *
 * With the camber slope eta(theta) = dz/dx, the Glauert Fourier
 * coefficients are
 *
 *     A_0 = alpha - (1/pi) integral_0^pi eta(theta) d theta
 *     A_n = (2/pi) integral_0^pi eta(theta) cos(n theta) d theta
 *
 * Zero-lift angle (alpha in RADIANS everywhere):
 *
 *     alpha_L0 = -(1/pi) integral_0^pi eta(theta) (cos theta - 1) d theta
 *              =  (1/pi) integral_0^pi eta(theta) (1 - cos theta) d theta
 *
 * The (cos theta - 1) weight is ESSENTIAL: dropping it changes the
 * magnitude and even the sign of alpha_L0 (it would then miss the A1/2
 * term entirely). With this standard sign convention a positively
 * cambered section (z >= 0, e.g. z = 4h x(1-x)) has NEGATIVE alpha_L0
 * (= -2h) and positive Cl at alpha = 0.
 *
 *     Cl          = 2 pi (A_0 + A_1/2) = 2 pi (alpha - alpha_L0)
 *     Cm_{c/4}    = (pi/4)(A_2 - A_1)        (independent of alpha)
 *
 * Loading per unit span (Anderson convention):
 *     Delta Cp(theta) = 4 A_0 (1+cos theta)/sin theta
 *                       + 4 sum_{n>=1} A_n sin(n theta)
 *
 * and integral_0^1 Delta Cp dx = 2 pi (A_0 + A_1/2) = Cl.
 */

import { CamberModel, thetaToX } from './types';
import { ServiceError } from './errors';

/** Thin-airfoil validity limit: |alpha| above this is refused (or flagged). */
export const MAX_ALPHA_RAD = (15 * Math.PI) / 180;

/** Number of Glauert harmonics retained for the pointwise loading. */
export const LOAD_HARMONICS = 64;

export interface AnalysisInput {
  model: CamberModel;
  /** Angle of attack in RADIANS. */
  alpha: number;
}

export interface LoadPoint {
  x: number;
  theta: number;
  deltaCp: number;
}

export interface AnalysisResult {
  /** Angle of attack used, radians. */
  alpha: number;
  /** Zero-lift angle of attack, radians (camber only). */
  alphaL0: number;
  /** Lift coefficient. */
  cl: number;
  /** Pitching-moment coefficient about the quarter-chord point. */
  cmQuarter: number;
  /** Glauert coefficients (diagnostics). */
  coefficients: {
    a0: number;
    a1: number;
    a2: number;
  };
  /** Chordwise loading Delta Cp(x). */
  loading: LoadPoint[];
  /** Cl reclaimed by integrating the returned loading — must match cl. */
  loadingIntegralCl: number;
}

/**
 * Guard the angle of attack.
 *  - non-finite input is a hard INVALID_ALPHA (400);
 *  - |alpha| above 15 degrees is ALPHA_OUT_OF_RANGE (422) unless
 *    `allowOutOfRange` is set, in which case the result is still computed
 *    and `outOfRange` is reported for the caller to flag.
 */
export function checkAlpha(
  alpha: unknown,
  allowOutOfRange = false,
): { alpha: number; outOfRange: boolean } {
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
    throw new ServiceError('INVALID_ALPHA', 'Angle of attack must be a finite number of radians', {
      received: String(alpha),
    });
  }
  const outOfRange = Math.abs(alpha) > MAX_ALPHA_RAD + 1e-12;
  if (outOfRange && !allowOutOfRange) {
    throw new ServiceError(
      'ALPHA_OUT_OF_RANGE',
      'Angle of attack exceeds the 15-degree thin-airfoil validity limit',
      {
        alphaRadians: alpha,
        alphaDegrees: (alpha * 180) / Math.PI,
        limitDegrees: 15,
        hint: 'Pass allowOutOfRange=true to compute anyway with an out-of-range flag.',
      },
    );
  }
  return { alpha, outOfRange };
}

/**
 * Compute alpha_L0 from camber only. Pure function of geometry.
 */
export function zeroLiftAngle(model: CamberModel): number {
  if (model.isZero()) return 0;
  const m0 = model.cosineMoment(0); // (1/pi) int eta d theta
  const m1 = model.cosineMoment(1); // (1/pi) int eta cos theta d theta
  // Standard thin-airfoil sign convention:
  //   alpha_L0 = -(1/pi) int eta (cos theta - 1) d theta = m0 - m1,
  // which is NEGATIVE for positively cambered sections (e.g. z = 4hx(1-x)
  // gives m1 = 2h, m0 = 0 and therefore alpha_L0 = -2h).  The
  // (cos theta - 1) weight must not be dropped.
  return m0 - m1;
}

/**
 * Full single-point evaluation. `sampleCount` controls the number of
 * interior points in the returned loading distribution.
 */
export function analyze(input: AnalysisInput, sampleCount = 129): AnalysisResult {
  const { model, alpha } = input;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
    throw new ServiceError('INVALID_ALPHA', 'Angle of attack must be a finite number of radians', {
      received: String(alpha),
    });
  }

  const m0 = model.cosineMoment(0);
  const m1 = model.cosineMoment(1);
  const m2 = model.cosineMoment(2);

  // Glauert coefficients.
  const a0 = alpha - m0;
  const a1 = 2 * m1;
  const a2 = 2 * m2;

  // Zero-lift angle:
  //   alpha_L0 = (1/pi) int eta (1 - cos theta) d theta = m0 - m1
  //          = -(1/pi) int eta (cos theta - 1) d theta
  // The (cos theta - 1) weight is mandatory.
  const alphaL0 = model.isZero() ? 0 : m0 - m1;

  const cl = 2 * Math.PI * (alpha - alphaL0);

  // Moment about c/4 depends only on the higher camber harmonics.
  const cmQuarter = (Math.PI / 4) * (a2 - a1);

  const loading = buildLoading(a0, a1, a2, model, sampleCount);
  const loadingIntegralCl = integrateLoadingCoefficients(a0, a1, a2, model);

  return {
    alpha,
    alphaL0,
    cl,
    cmQuarter,
    coefficients: { a0, a1, a2 },
    loading,
    loadingIntegralCl,
  };
}

/** Evaluate Delta Cp at one angle theta from the retained Fourier series.
 *  Delta Cp = 4 A0 (1+cos theta)/sin theta + 4 sum_{n>=1} A_n sin(n theta). */
function loadingValue(theta: number, A: Float64Array): number {
  const sinT = Math.sin(theta);
  let series = 0;
  let sinPrev = 0; // sin(0)
  let sinCur = sinT; // sin(theta)
  const twoCos = 2 * Math.cos(theta);
  for (let n = 1; n < A.length; n += 1) {
    series += A[n] * sinCur;
    const sinNext = twoCos * sinCur - sinPrev;
    sinPrev = sinCur;
    sinCur = sinNext;
  }
  return (4 * A[0] * (1 + Math.cos(theta))) / sinT + 4 * series;
}

/**
 * Build the chordwise loading on a uniform theta grid of interior
 * MIDPOINTS (endpoints excluded: theta = 0 carries the leading-edge
 * singularity and theta = pi gives 0/0 at the trailing edge).
 */
function buildLoading(
  a0: number,
  a1: number,
  a2: number,
  model: CamberModel,
  sampleCount: number,
): LoadPoint[] {
  const count = Math.max(2, Math.floor(sampleCount));
  const N = LOAD_HARMONICS;

  // Precompute Fourier coefficients for the retained harmonics.
  const A = new Float64Array(N + 1);
  A[0] = a0;
  A[1] = a1;
  A[2] = a2;
  for (let n = 3; n <= N; n += 1) {
    A[n] = 2 * model.cosineMoment(n);
  }

  const points: LoadPoint[] = [];
  const dTheta = Math.PI / count;
  for (let i = 0; i < count; i += 1) {
    const theta = (i + 0.5) * dTheta;
    points.push({ x: thetaToX(theta), theta, deltaCp: loadingValue(theta, A) });
  }
  return points;
}

/**
 * Integrate Delta Cp over the chord on a fine INTERNAL midpoint grid:
 *
 *     Cl = integral_0^1 Delta Cp dx
 *        = (1/2) integral_0^pi Delta Cp(theta) sin theta d theta
 *
 * Multiplication by sin theta removes the leading-edge singularity:
 *
 *     Delta Cp sin theta = 4 A0 (1+cos theta)
 *                          + 4 sum A_n sin(n theta) sin theta
 *
 * whose exact integral over [0, pi] is 2 pi A0 + pi A1 = 2 pi (A0 + A1/2)
 * = Cl.  A fine midpoint rule reclaims Cl to far tighter accuracy than the
 * (possibly coarse) sampling returned to the caller.
 */
function integrateLoadingCoefficients(
  a0: number,
  a1: number,
  a2: number,
  model: CamberModel,
): number {
  const A = new Float64Array(LOAD_HARMONICS + 1);
  A[0] = a0;
  A[1] = a1;
  A[2] = a2;
  for (let n = 3; n <= LOAD_HARMONICS; n += 1) {
    A[n] = 2 * model.cosineMoment(n);
  }

  const cells = 4001;
  const dTheta = Math.PI / cells;
  let acc = 0;
  for (let i = 0; i < cells; i += 1) {
    const theta = (i + 0.5) * dTheta;
    let series = 0;
    let sinPrev = 0;
    let sinCur = Math.sin(theta);
    const twoCos = 2 * Math.cos(theta);
    for (let n = 1; n < A.length; n += 1) {
      series += A[n] * sinCur;
      const sinNext = twoCos * sinCur - sinPrev;
      sinPrev = sinCur;
      sinCur = sinNext;
    }
    // Delta Cp * sin theta
    acc += 4 * A[0] * (1 + Math.cos(theta)) + 4 * series * Math.sin(theta);
  }
  return 0.5 * acc * dTheta;
}
