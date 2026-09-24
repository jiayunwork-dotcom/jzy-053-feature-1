/**
 * Inverse thin-airfoil design: invert the aerodynamic targets into a
 * camber line that the FORWARD evaluator accepts unchanged.
 *
 * The module is intentionally separate from analyze.ts: it only imports
 * the forward kernel to VERIFY its own result, never mutates it. All
 * functions here are pure — a solve call keeps no mutable state, so
 * concurrent requests are isolated by construction.
 *
 * ---------------------------------------------------------------------------
 * Theory (same Glauert conventions as the forward kernel)
 * ---------------------------------------------------------------------------
 *
 * Parameterise the camber SLOPE as a finite Glauert cosine series
 *
 *     eta(theta) = dz/dx = sum_{n=0}^{N} b_n cos(n theta),
 *
 * with x = (1 - cos theta)/2.  The cosine moments consumed by the forward
 * kernel are then m_0 = b_0 and m_n = b_n/2 (n >= 1), hence
 *
 *     A_0     = alpha - b_0,          A_n = b_n  (n >= 1)
 *     alpha_L0 = b_0 - b_1/2
 *     Cl       = 2 pi (alpha - alpha_L0)
 *     Cm,c/4   = (pi/4)(b_2 - b_1)
 *
 * The leading/trailing-edge gauge z(0) = z(1) = 0 (a closed chord line;
 * excludes the constant and the rigid-rotation term that thin-airfoil
 * theory cannot distinguish from angle of attack) gives
 *
 *     z(1) = (1/2) int_0^pi eta(theta) sin(theta) d theta
 *          = b_0 + sum_{n>=2, n even} b_n / (1 - n^2) = 0.
 *
 * ---------------------------------------------------------------------------
 * Selection criterion: minimum Glauert order ("smoothest, lowest order")
 * ---------------------------------------------------------------------------
 *
 * The inverse problem is underdetermined (infinitely many camber lines
 * share one Cl).  We close it with a SINGLE deterministic rule:
 *
 *   Among every camber line satisfying the targets and the closed-chord
 *   gauge, retain the LOWEST-ORDER Glauert slope harmonics only; every
 *   coefficient that the constraints do not pin is set identically to
 *   zero.
 *
 * This is the classical minimum-camber / minimum-curvature inverse rule:
 * camber content lives in the smallest n that can physically carry the
 * requested quantity (lift rides n = 1, the quarter-chord moment needs
 * n = 2, a distributed shape needs a fitted truncated spectrum).  It
 * contains no randomness — identical targets always return the identical
 * camber line — and its active harmonic set is reported with every
 * solution so the choice is auditable.
 *
 * Three target levels map onto three nested active sets:
 *
 *   1. lift only ............... {b_1},  b_0 = b_2 = ... = 0
 *   2. lift + pinned Cm ........ {b_1, b_2}, b_0 = b_2/3 (closure)
 *      (Cm given as an interval: clamp the unconstrained minimum-energy
 *       point into the interval, then use the same two harmonics)
 *   3. chordwise loading ....... {b_0..b_N}, N = min(12, M-1) for M
 *      samples; coefficients are the order-truncated least-squares fit of
 *      Delta Cp, solved with equality constraints when Cl and/or Cm are
 *      pinned alongside the loading.
 *
 * The synthesised line is returned in one of the two EXISTING camber
 * representations (polynomial coefficients / discrete points), so it can
 * be fed straight back into /analyze, /sweep, /analyze/batch or registered
 * as a named profile without any parallel representation.
 */

import { CamberDef, thetaToX, xToTheta } from './types';
import { buildCamberModel } from './camber';
import { analyze, checkAlpha, MAX_ALPHA_RAD } from './analyze';
import { ServiceError } from './errors';

/* ------------------------------------------------------------------ */
/* Published tolerances and limits                                     */
/* ------------------------------------------------------------------ */

/** Closed-loop acceptance: re-running the forward evaluator at the
 *  reference alpha must reproduce the requested/predicted Cl within this. */
export const INVERSE_CL_TOLERANCE = 1e-6;
/** Closed-loop acceptance for a pinned (or exactly zero) Cm,c/4. */
export const INVERSE_CM_TOLERANCE = 1e-5;
/** Closed-loop RMS acceptance of the reproduced Delta Cp samples. */
export const INVERSE_LOADING_RMS_TOLERANCE = 2e-2;

/** Pre-solve conflict slack: the scalar implied by a free loading fit
 *  must agree with a pinned scalar at least this closely, otherwise the
 *  target is self-contradictory before any solve runs. */
const CONFLICT_TOLERANCE = 0.05;
/** Trailing-edge closure residual above which a loading target is judged
 *  incompatible with a closed thin airfoil at the given reference alpha. */
const TRAILING_EDGE_GAP_LIMIT = 0.02;
/** Harmonic coefficients below this are treated as exactly zero when
 *  deciding whether a tier-3 fit collapses to a polynomial. */
const HARMONIC_ZERO = 1e-9;

const MAX_FIT_HARMONICS = 12;
const LOADING_EVAL_HARMONICS = 64;
const DEFAULT_OUTPUT_POINTS = 1201; // cosine-spaced, dense at both edges
const MIN_OUTPUT_POINTS = 1024;
const MAX_OUTPUT_POINTS = 2048;
const VERIFY_SAMPLES = 257;
const DIAGNOSTIC_GRID = 2001;

/** Default thin-airfoil design envelope. The geometric bounds are NOT
 *  theory validity limits (unlike the 15-degree incidence line) — they are
 *  sensible default camber-design limits that callers may relax or remove
 *  through `bounds`. */
export const DEFAULT_MAX_CAMBER = 0.15;
export const DEFAULT_MAX_SLOPE = 0.6;

/* ------------------------------------------------------------------ */
/* Request types (validated by validation.ts before reaching here)     */
/* ------------------------------------------------------------------ */

export type CmTarget = number | { min: number; max: number };
export type LoadingCoordinate = { x: number; deltaCp: number } | { theta: number; deltaCp: number };
export type OutputRepresentation = 'auto' | 'polynomial' | 'points';

export interface InverseBounds {
  /** Max |z| over the chord. */
  maxCamber?: number | null;
  /** Max |dz/dx| over the chord. */
  maxSlope?: number | null;
}

export interface RegisterRequest {
  id: string;
  name?: string;
  description?: string;
}

export interface InverseRequest {
  /** Reference angle of attack in RADIANS. */
  alpha: number;
  /** Wanted lift coefficient at the reference alpha. */
  cl?: number;
  /** Wanted quarter-chord moment: exact value or inclusive interval. */
  cmQuarter?: CmTarget;
  /** Wanted chordwise dimensionless loading Delta Cp(x) (or Delta Cp(theta)). */
  loading?: LoadingCoordinate[];
  allowOutOfRange?: boolean;
  output?: OutputRepresentation;
  bounds?: InverseBounds;
  /** Number of samples of a synthesised point camber line. */
  samples?: number;
  /** When present, the verified camber line is also registered as a profile. */
  register?: RegisterRequest;
}

export type TargetKind = 'lift' | 'lift-moment' | 'loading';

export interface InverseVerification {
  alpha: number;
  cl: number;
  cmQuarter: number;
  clError: number;
  cmError: number;
  loadingRmsError?: number;
  tolerance: { cl: number; cm: number; loadingRms?: number };
  passed: boolean;
}

export interface InverseDiagnostics {
  maxCamber: number;
  maxSlope: number;
  /** z(1) residual: 0 exactly for lift/lift-moment targets, near 0 for a
   *  loading target consistent with a closed chord line. */
  trailingEdgeGap: number;
  /** RMS fit residual of Delta Cp (loading targets only). */
  fitRms?: number;
  /** Highest Glauert harmonic retained. */
  harmonics: number;
  /** Harmonic coefficients actually used (b_0 .. b_N). */
  slopeCoefficients: number[];
  outputRepresentation: 'polynomial' | 'points';
}

export interface InverseResult {
  target: {
    kind: TargetKind;
    alpha: number;
    cl?: number;
    cmQuarter?: number;
    cmQuarterInterval?: { min: number; max: number };
    loadingSamples?: number;
  };
  camber: CamberDef;
  selectionCriterion: {
    id: 'minimum-glauert-order';
    description: string;
    activeHarmonics: number[];
    gauge: 'z(0)=z(1)=0 closed chord line';
  };
  prediction: {
    alphaL0: number;
    cl: number;
    cmQuarter: number;
    coefficients: { a0: number; a1: number; a2: number };
  };
  verification: InverseVerification;
  diagnostics: InverseDiagnostics;
  outOfRange: boolean;
}

/* ------------------------------------------------------------------ */
/* Solver entry point                                                  */
/* ------------------------------------------------------------------ */

export function inverseDesign(req: InverseRequest): InverseResult {
  // Reference alpha is a normal angle-of-attack input: reuse the forward
  // kernel's 15-degree guard (honouring allowOutOfRange).
  const { alpha, outOfRange } = checkAlpha(req.alpha, req.allowOutOfRange ?? false);

  const bounds = resolveBounds(req.bounds);

  if (req.loading !== undefined) {
    const result = solveLoading(alpha, req, bounds, outOfRange);
    verifyAndFinalize(result, alpha, req);
    return result;
  }
  if (req.cl !== undefined) {
    const result =
      req.cmQuarter !== undefined
        ? solveLiftMoment(alpha, req.cl, req.cmQuarter)
        : solveLift(alpha, req.cl);
    // Even with a valid reference alpha, the camber needed to meet the
    // target can drive the effective leading-edge incidence A0 = alpha - m0
    // beyond thin-airfoil theory's range. Guard it exactly as for loading.
    const a0OutOfRange = Math.abs(result.prediction.coefficients.a0) > MAX_ALPHA_RAD + 1e-12;
    result.outOfRange = outOfRange || a0OutOfRange;
    if (a0OutOfRange && !(req.allowOutOfRange ?? false)) {
      const a0 = result.prediction.coefficients.a0;
      throw new ServiceError(
        'TARGET_UNACHIEVABLE',
        `Meeting the target at alpha = ${trunc(alpha)} rad needs an effective leading-edge ` +
          `incidence A0 = ${trunc(a0)} rad (${trunc((a0 * 180) / Math.PI)} deg), beyond the ` +
          `15-degree thin-airfoil validity limit`,
        { a0, a0Degrees: (a0 * 180) / Math.PI, alpha, limitDegrees: 15 },
      );
    }
    // Honour an explicit points representation for the scalar tiers too:
    // sample the synthesised polynomial on the same cosine grid. 'auto'
    // leaves these exact low-order lines as polynomials.
    if (req.output === 'points' && result.camber.kind === 'polynomial') {
      convertScalarResultToPoints(result, req.samples);
    }
    enforceGeometricBounds(result, bounds);
    verifyAndFinalize(result, alpha, req);
    return result;
  }
  // Validation should have caught this; keep the guard here so the math
  // module never silently invents a target interpretation.
  throw new ServiceError(
    'INVALID_TARGET',
    "An inverse request must specify 'cl' (optionally with 'cmQuarter') or 'loading'",
  );
}

/* ------------------------------------------------------------------ */
/* Level 1: prescribed lift at the reference alpha                     */
/* ------------------------------------------------------------------ */

/**
 * Resample an exact scalar-tier polynomial camber as discrete cosine-grid
 * points when the caller explicitly requests the points representation.
 * The geometry diagnostics are recomputed from the actual samples that
 * will be returned (the closed-loop verification runs afterwards through
 * the ordinary piecewise-linear camber constructor).
 */
function convertScalarResultToPoints(result: InverseResult, samples: number | undefined): void {
  if (result.camber.kind !== 'polynomial') return;
  const coeffs = result.camber.coefficients;
  const count = clampPointCount(samples);
  const points: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (i * Math.PI) / (count - 1);
    const x = thetaToX(theta);
    let z = 0;
    for (let k = coeffs.length - 1; k >= 0; k -= 1) z = z * x + (coeffs[k] ?? 0);
    points.push({ x, z });
  }
  result.camber = { kind: 'points', points };
  result.diagnostics.outputRepresentation = 'points';
  // Rescan the discretised line for the geometric envelope.
  let maxCamber = 0;
  let maxSlope = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (Math.abs(points[i].z) > maxCamber) maxCamber = Math.abs(points[i].z);
    if (i > 0) {
      const s = (points[i].z - points[i - 1].z) / (points[i].x - points[i - 1].x);
      if (Math.abs(s) > maxSlope) maxSlope = Math.abs(s);
    }
  }
  result.diagnostics.maxCamber = maxCamber;
  result.diagnostics.maxSlope = maxSlope;
}

/**
 * Cl = 2 pi (alpha - alpha_L0) pins alpha_L0* = alpha - Cl/(2 pi).
 * The lowest-order slope that carries lift is eta = b_1 cos theta, with
 * b_0 = b_2 = ... = 0; closure z(1) = 0 is then automatic (odd harmonics
 * integrate to zero against sin theta).  The line is the parabola
 *
 *     z(x) = b_1 x (1 - x),   b_1 = Cl/pi - 2 alpha.
 */
function solveLift(alpha: number, clTarget: number): InverseResult {
  const alphaL0Star = alpha - clTarget / (2 * Math.PI);
  const b1 = -2 * alphaL0Star; // = Cl/pi - 2 alpha
  const b = [0, b1];
  const camber: CamberDef = {
    kind: 'polynomial',
    // z = b1 x - b1 x^2
    coefficients: [0, b1, -b1],
  };
  const result = assembleResult({
    kind: 'lift',
    alpha,
    clTarget,
    cmTarget: 0,
    b,
    camber,
    activeHarmonics: [1],
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Level 2: prescribed lift and quarter-chord moment                   */
/* ------------------------------------------------------------------ */

/**
 * With eta = b_0 + b_1 cos theta + b_2 cos 2 theta, closure gives
 *
 *     b_0 = b_2 / 3.
 *
 * Writing L = alpha_L0* = alpha - Cl/(2 pi) and d = Cm/pi, the two
 * scalar constraints give
 *
 *     b_0 = -2 L + 4 d
 *     b_1 = -6 L + 8 d
 *     b_2 = -6 L + 12 d
 *
 * and therefore a CUBIC camber polynomial
 *
 *     z(x) = (b_0+b_1+b_2) x - (b_1+4 b_2) x^2 + (8/3) b_2 x^3.
 *
 * There is no Cl/Cm pair this space cannot represent exactly; a moment
 * given as an interval is met at the unconstrained minimum of
 * b_0^2+b_1^2+b_2^2, i.e. d* = 4 L/7, clamped into [d_min, d_max].
 */
function solveLiftMoment(
  alpha: number,
  clTarget: number,
  cm: CmTarget,
): InverseResult {
  const L = alpha - clTarget / (2 * Math.PI);
  let d: number;
  let interval: { min: number; max: number } | undefined;
  let cmResolved: number;

  if (typeof cm === 'number') {
    d = cm / Math.PI;
    cmResolved = cm;
  } else {
    const dMin = cm.min / Math.PI;
    const dMax = cm.max / Math.PI;
    const dStar = (4 * L) / 7; // unconstrained minimum-energy point
    d = Math.min(dMax, Math.max(dMin, dStar));
    cmResolved = Math.PI * d;
    interval = { min: cm.min, max: cm.max };
  }

  const b0 = -2 * L + 4 * d;
  const b1 = -6 * L + 8 * d;
  const b2 = -6 * L + 12 * d;
  const b = [b0, b1, b2];

  const camber: CamberDef = {
    kind: 'polynomial',
    coefficients: [
      0,
      b0 + b1 + b2,
      -(b1 + 4 * b2),
      (8 / 3) * b2,
    ],
  };

  return assembleResult({
    kind: 'lift-moment',
    alpha,
    clTarget,
    cmTarget: cmResolved,
    cmInterval: interval,
    b,
    camber,
    activeHarmonics: [0, 1, 2],
  });
}

/* ------------------------------------------------------------------ */
/* Level 3: prescribed chordwise loading                               */
/* ------------------------------------------------------------------ */

interface NormalisedLoadingSample {
  theta: number;
  x: number;
  deltaCp: number;
}

/**
 * Fit the requested Delta Cp samples with the lowest-order truncation
 *
 *     Delta Cp(theta) = 4 A_0 (1+cos theta)/sin theta
 *                      + 4 sum_{n=1}^{N} b_n sin(n theta),
 *
 * i.e. exactly the forward kernel's loading formula, by unweighted least
 * squares in theta.  Pinned Cl / Cm are imposed as linear equalities on
 * the fit (KKT system) — but only AFTER a free fit has been checked for
 * self-contradiction, so a pinned value that the demanded shape cannot
 * carry is rejected before the solve instead of being forced into a
 * wild line.
 */
function solveLoading(
  alpha: number,
  req: InverseRequest,
  bounds: ResolvedBounds,
  outOfRange: boolean,
): InverseResult {
  const samples = normaliseLoadingSamples(req.loading as LoadingCoordinate[]);
  const M = samples.length;
  const N = Math.min(MAX_FIT_HARMONICS, M - 1);
  const K = N + 1; // unknowns: A0, b_1, ..., b_N

  // Model matrix Phi (M x K) and observations y.
  const Phi = matrix(M, K);
  const y = new Float64Array(M);
  for (let i = 0; i < M; i += 1) {
    const theta = samples[i].theta;
    Phi[i][0] = (4 * (1 + Math.cos(theta))) / Math.sin(theta);
    for (let n = 1; n <= N; n += 1) {
      Phi[i][n] = 4 * Math.sin(n * theta);
    }
    y[i] = samples[i].deltaCp;
  }

  // Normal equations for the free fit: (Phi^T Phi) c = Phi^T y. Keep the
  // pristine HtH/Hty for the later constrained solves — gaussianSolve
  // overwrites its arguments in place.
  const HtH = matTMat(Phi, M, K);
  const Hty = matTVec(Phi, y, M, K);
  const cFree = gaussianSolve(cloneMatrix(HtH), Hty.slice(), K);

  const freeB = bFromCoefficients(cFree, alpha, N);
  // Cm rides only b_1, b_2, which the closure constraint never moves, so
  // the free fit's implied moment is already the closed line's moment.
  const impliedCm = (Math.PI / 4) * (freeB[2] - freeB[1]);

  // A grossly open free fit (|z(1)| beyond the gap limit) means no closed
  // line at this reference alpha can carry the demanded shape; reject it
  // before the constrained solve rather than distorting the shape closed.
  const freeGap = trailingEdgeGap(freeB);
  if (Math.abs(freeGap) > TRAILING_EDGE_GAP_LIMIT - 1e-9) {
    throw new ServiceError(
      'TARGET_UNACHIEVABLE',
      `The demanded loading implies an open trailing edge with z(1) = ${trunc(freeGap)}; a closed ` +
        `thin airfoil at alpha = ${trunc(alpha)} cannot carry this loading`,
      { trailingEdgeGap: freeGap, alpha, limit: TRAILING_EDGE_GAP_LIMIT },
    );
  }

  // Closure is a property of EVERY admissible line, so the baseline against
  // which a pinned Cl must be judged is the closest CLOSED fit, not the free
  // one: closing can shift A0 (and hence Cl) without changing the shape's
  // even harmonics. A pinned scalar this baseline cannot reach is rejected
  // BEFORE adding the pin, rather than forcing a wild line.
  const cClosed = solveWithConstraints(HtH, Hty, K, [closureConstraint(alpha, K, N)]);
  const closedA0 = cClosed[0];
  const closedB = bFromCoefficients(cClosed, alpha, N);
  const impliedCl = 2 * Math.PI * (closedA0 + closedB[1] / 2);

  const conflictLimit = CONFLICT_TOLERANCE - 1e-9;
  const cmPin = typeof req.cmQuarter === 'number' ? req.cmQuarter : undefined;
  const clPin = req.cl;
  if (clPin !== undefined && Math.abs(impliedCl - clPin) > conflictLimit) {
    throw new ServiceError(
      'TARGET_INCONSISTENT',
      `The closest closed line matching the demanded loading carries Cl = ${trunc(impliedCl)}, ` +
        `which cannot meet the pinned Cl = ${clPin} within thin-airfoil theory`,
      {
        loadingImpliedCl: impliedCl,
        pinnedCl: clPin,
        discrepancy: impliedCl - clPin,
      },
    );
  }
  if (cmPin !== undefined && Math.abs(impliedCm - cmPin) > conflictLimit) {
    const symmetric =
      Math.abs(impliedCm) < 1e-9 && Math.abs(freeB[1]) < 1e-7 && Math.abs(freeB[2]) < 1e-7;
    throw new ServiceError(
      'TARGET_INCONSISTENT',
      symmetric
        ? 'The demanded loading is the symmetric-section loading, whose quarter-chord moment ' +
            'is identically zero; it cannot carry the pinned non-zero Cm,c/4'
        : `The demanded loading implies Cm,c/4 = ${trunc(impliedCm)}, which cannot meet the ` +
            `pinned Cm,c/4 = ${cmPin} within thin-airfoil theory`,
      {
        loadingImpliedCm: impliedCm,
        pinnedCm: cmPin,
        discrepancy: impliedCm - cmPin,
        ...(symmetric ? { reason: 'SYMMETRIC_LOADING_ZERO_MOMENT' } : {}),
      },
    );
  }
  if (typeof req.cmQuarter === 'object') {
    const iv = req.cmQuarter;
    if (impliedCm < iv.min - conflictLimit || impliedCm > iv.max + conflictLimit) {
      throw new ServiceError(
        'TARGET_INCONSISTENT',
        `The demanded loading implies Cm,c/4 = ${trunc(impliedCm)}, outside the requested ` +
          `interval [${iv.min}, ${iv.max}]`,
        { loadingImpliedCm: impliedCm, interval: iv },
      );
    }
  }

  // --- final fit: closure ALWAYS, plus any exact scalar pins ----------
  const scalarConstraints: Array<{ row: Float64Array; rhs: number }> = [
    closureConstraint(alpha, K, N),
  ];
  if (clPin !== undefined) {
    const row = new Float64Array(K);
    row[0] = 1; // A0
    row[1] = 0.5; // b_1/2
    scalarConstraints.push({ row, rhs: clPin / (2 * Math.PI) });
  }
  if (cmPin !== undefined) {
    const row = new Float64Array(K);
    row[1] = -1; // -b_1
    row[2] = 1; // +b_2
    scalarConstraints.push({ row, rhs: (4 * cmPin) / Math.PI });
  }
  const c = solveWithConstraints(HtH, Hty, K, scalarConstraints);

  const a0 = c[0];
  const b = bFromCoefficients(c, alpha, N);
  const clPrediction = 2 * Math.PI * (a0 + b[1] / 2);
  const cmPrediction = (Math.PI / 4) * (b[2] - b[1]);

  // Closure is imposed exactly above; the residual must be at round-off.
  const gap = trailingEdgeGap(b);
  if (Math.abs(gap) > 1e-9) {
    throw new ServiceError(
      'INTERNAL',
      `Constrained loading fit failed to close the trailing edge (z(1) = ${gap})`,
      { trailingEdgeGap: gap },
    );
  }

  // Effective-incidence guard (the leading-edge singularity strength).
  const a0OutOfRange = Math.abs(a0) > MAX_ALPHA_RAD + 1e-12;
  if (a0OutOfRange && !(req.allowOutOfRange ?? false)) {
    throw new ServiceError(
      'TARGET_UNACHIEVABLE',
      `Reproducing the demanded loading needs an effective leading-edge incidence A0 = ` +
        `${trunc(a0)} rad (${trunc((a0 * 180) / Math.PI)} deg), beyond the 15-degree ` +
        `thin-airfoil validity limit`,
      { a0: a0, a0Degrees: (a0 * 180) / Math.PI, limitDegrees: 15 },
    );
  }

  // Output representation.
  const higherHarmonics = maxAbs(b, 3);
  const wantsPolynomial = req.output === 'polynomial';
  const canBePolynomial = higherHarmonics < HARMONIC_ZERO;
  if (wantsPolynomial && !canBePolynomial) {
    throw new ServiceError(
      'INVALID_TARGET',
      `The loading target needs Glauert harmonics through n = ${N}; a polynomial camber line ` +
        `(cubic at most, harmonics 0..2) cannot represent it. Use output 'points' or 'auto'.`,
      { requiredHarmonics: N, maxHigherHarmonic: higherHarmonics },
    );
  }

  const pointCount = clampPointCount(req.samples);
  const camber = canBePolynomial
    ? polynomialFromLowHarmonics(b)
    : pointsFromSpectrum(b, pointCount);
  const rep = canBePolynomial ? 'polynomial' : 'points';

  // Fit RMS of the FINAL spectrum against the requested samples.
  let fitSse = 0;
  for (let i = 0; i < M; i += 1) {
    const v = loadingFromSpectrum(samples[i].theta, a0, b, N);
    const e = v - y[i];
    fitSse += e * e;
  }
  const fitRms = Math.sqrt(fitSse / M);

  const active: number[] = [];
  for (let n = 0; n <= N; n += 1) if (Math.abs(b[n]) >= HARMONIC_ZERO) active.push(n);

  const result: InverseResult = {
    target: {
      kind: 'loading',
      alpha,
      ...(clPin !== undefined ? { cl: clPin } : {}),
      ...(cmPin !== undefined ? { cmQuarter: cmPin } : {}),
      ...(typeof req.cmQuarter === 'object' ? { cmQuarterInterval: req.cmQuarter } : {}),
      loadingSamples: M,
    },
    camber,
    selectionCriterion: {
      id: 'minimum-glauert-order',
      description:
        `Order-truncated least-squares fit of the demanded Delta Cp onto the lowest ` +
        `${N} Glauert harmonics, with the closed-chord gauge z(0)=z(1)=0 imposed exactly` +
        `${scalarConstraints.length > 1 ? ', together with the pinned scalar constraint(s)' : ''}; ` +
        `all higher harmonics are identically zero.`,
      activeHarmonics: active,
      gauge: 'z(0)=z(1)=0 closed chord line',
    },
    prediction: {
      alphaL0: b[0] - b[1] / 2,
      cl: clPrediction,
      cmQuarter: cmPrediction,
      coefficients: { a0, a1: b[1], a2: b[2] },
    },
    verification: emptyVerification(alpha),
    diagnostics: {
      maxCamber: 0,
      maxSlope: 0,
      trailingEdgeGap: gap,
      fitRms,
      harmonics: N,
      slopeCoefficients: Array.from(b),
      outputRepresentation: rep,
    },
    outOfRange: outOfRange || a0OutOfRange,
  };
  fillGeometryDiagnostics(result, b);
  enforceGeometricBounds(result, bounds);
  return result;
}

/* ------------------------------------------------------------------ */
/* Shared assembly + closed-loop verification                          */
/* ------------------------------------------------------------------ */

interface AssembleArgs {
  kind: TargetKind;
  alpha: number;
  clTarget: number;
  cmTarget: number;
  cmInterval?: { min: number; max: number };
  b: number[];
  camber: CamberDef;
  activeHarmonics: number[];
}

function assembleResult(args: AssembleArgs): InverseResult {
  const { alpha, b } = args;
  const a0 = alpha - b[0];
  const a1 = b[1] ?? 0;
  const a2 = b[2] ?? 0;
  const cl = 2 * Math.PI * (a0 + a1 / 2);
  const cm = (Math.PI / 4) * (a2 - a1);

  const a0OutOfRange = Math.abs(a0) > MAX_ALPHA_RAD + 1e-12;

  const result: InverseResult = {
    target: {
      kind: args.kind,
      alpha,
      cl: args.clTarget,
      ...(args.kind === 'lift-moment' ? { cmQuarter: args.cmTarget } : {}),
      ...(args.cmInterval ? { cmQuarterInterval: args.cmInterval } : {}),
    },
    camber: args.camber,
    selectionCriterion: {
      id: 'minimum-glauert-order',
      description:
        args.kind === 'lift'
          ? 'Lowest-order camber carrying the prescribed lift: slope eta = b1 cos(theta) only; ' +
            'every unconstrained Glauert harmonic (including b0 via closed-trailing-edge) is zero. ' +
            'This is the unique minimum-camber parabola z = b1 x(1-x).'
          : 'Lowest-order camber carrying prescribed lift and quarter-chord moment: slope harmonics ' +
            '{b0,b1,b2} only, b0 fixed by trailing-edge closure; all n >= 3 harmonics zero. ' +
            'This is the unique minimum-camber cubic camber.',
      activeHarmonics: args.activeHarmonics.slice(),
      gauge: 'z(0)=z(1)=0 closed chord line',
    },
    prediction: {
      alphaL0: b[0] - b[1] / 2,
      cl,
      cmQuarter: cm,
      coefficients: { a0, a1, a2 },
    },
    verification: emptyVerification(alpha),
    diagnostics: {
      maxCamber: 0,
      maxSlope: 0,
      trailingEdgeGap: 0,
      harmonics: b.length - 1,
      slopeCoefficients: b.slice(),
      outputRepresentation: 'polynomial',
    },
    outOfRange: a0OutOfRange,
  };
  fillGeometryDiagnostics(result, b);
  return result;
}

function emptyVerification(alpha: number): InverseVerification {
  return {
    alpha,
    cl: NaN,
    cmQuarter: NaN,
    clError: NaN,
    cmError: NaN,
    tolerance: { cl: INVERSE_CL_TOLERANCE, cm: INVERSE_CM_TOLERANCE },
    passed: false,
  };
}

/**
 * THE hard requirement: feed the synthesised line back through the
 * UNMODIFIED forward evaluator and demand the targets back. A failure
 * here is a service bug, never a client error.
 */
function verifyAndFinalize(result: InverseResult, alpha: number, req: InverseRequest): void {
  // Defensive: the synthesised definition must build as ordinary camber.
  let model;
  try {
    model = buildCamberModel(result.camber);
  } catch (err) {
    throw new ServiceError(
      'INTERNAL',
      `Synthesised camber line failed forward geometry validation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const forward = analyze({ model, alpha }, VERIFY_SAMPLES);

  const clWanted = result.target.cl ?? result.prediction.cl;
  // Which Cm must the closed-loop evaluator reproduce? Only a Cm the
  // caller actually pinned:
  //  - lift-moment target: the exact pinned value (or the value selected
  //    inside a supplied interval);
  //  - loading target with an exact pin: that pin;
  //  - loading target with an interval: the value the fit selected;
  //  - lift-only / loading-only: no moment was demanded, so the minimum-
  //    order solution's Cm (0 for the parabola) is reported, not enforced.
  let cmWanted: number | undefined;
  if (result.target.kind === 'lift-moment') {
    cmWanted = result.prediction.cmQuarter;
  } else if (result.target.kind === 'loading') {
    if (result.target.cmQuarter !== undefined) cmWanted = result.target.cmQuarter;
    else if (result.target.cmQuarterInterval !== undefined) cmWanted = result.prediction.cmQuarter;
  }

  const clError = Math.abs(forward.cl - clWanted);
  const cmError = cmWanted === undefined ? 0 : Math.abs(forward.cmQuarter - cmWanted);

  let loadingRmsError: number | undefined;
  if (req.loading !== undefined) {
    const samples = normaliseLoadingSamples(req.loading);
    let sse = 0;
    for (const s of samples) {
      const reproduced = deltaCpFromModel(model, alpha, s.theta);
      const e = reproduced - s.deltaCp;
      sse += e * e;
    }
    loadingRmsError = Math.sqrt(sse / samples.length);
  }

  const passed =
    clError <= INVERSE_CL_TOLERANCE &&
    cmError <= INVERSE_CM_TOLERANCE &&
    (loadingRmsError === undefined || loadingRmsError <= INVERSE_LOADING_RMS_TOLERANCE);

  if (!passed) {
    throw new ServiceError(
      'INTERNAL',
      'Inverse solution failed its own closed-loop forward verification',
      {
        clError,
        cmError,
        loadingRmsError,
        tolerance: {
          cl: INVERSE_CL_TOLERANCE,
          cm: INVERSE_CM_TOLERANCE,
          loadingRms: INVERSE_LOADING_RMS_TOLERANCE,
        },
      },
    );
  }

  result.verification = {
    alpha: forward.alpha,
    cl: forward.cl,
    cmQuarter: forward.cmQuarter,
    clError,
    cmError,
    ...(loadingRmsError !== undefined ? { loadingRmsError } : {}),
    tolerance: {
      cl: INVERSE_CL_TOLERANCE,
      cm: INVERSE_CM_TOLERANCE,
      ...(loadingRmsError !== undefined ? { loadingRms: INVERSE_LOADING_RMS_TOLERANCE } : {}),
    },
    passed: true,
  };
}

/* ------------------------------------------------------------------ */
/* Geometry diagnostics and physical guards                            */
/* ------------------------------------------------------------------ */

interface ResolvedBounds {
  maxCamber: number | null;
  maxSlope: number | null;
}

function resolveBounds(bounds: InverseBounds | undefined): ResolvedBounds {
  if (bounds === undefined) {
    return { maxCamber: DEFAULT_MAX_CAMBER, maxSlope: DEFAULT_MAX_SLOPE };
  }
  return {
    // bounds object present: a stated number overrides the default, an
    // omitted/null field disables that specific guard.
    maxCamber: typeof bounds.maxCamber === 'number' ? bounds.maxCamber : null,
    maxSlope: typeof bounds.maxSlope === 'number' ? bounds.maxSlope : null,
  };
}

/** Evaluate max |z| and max |eta| of the synthesised line on a fine grid.
 *  For polynomial tiers the spectrum integrates exactly; for the point
 *  tier we additionally scan the actual samples that will be returned. */
function fillGeometryDiagnostics(result: InverseResult, b: number[]): void {
  let maxSlope = 0;
  let maxZ = 0;
  const N = b.length - 1;
  for (let i = 0; i <= DIAGNOSTIC_GRID; i += 1) {
    const theta = (i * Math.PI) / DIAGNOSTIC_GRID;
    const eta = slopeFromSpectrum(theta, b, N);
    const z = camberZFromSpectrum(theta, b, N);
    if (Math.abs(eta) > maxSlope) maxSlope = Math.abs(eta);
    if (Math.abs(z) > maxZ) maxZ = Math.abs(z);
  }
  if (result.camber.kind === 'points') {
    for (const p of result.camber.points) {
      if (Math.abs(p.z) > maxZ) maxZ = Math.abs(p.z);
    }
  }
  result.diagnostics.maxCamber = maxZ;
  result.diagnostics.maxSlope = maxSlope;
}

function enforceGeometricBounds(result: InverseResult, bounds: ResolvedBounds): void {
  const { maxCamber, maxSlope } = result.diagnostics;
  if (bounds.maxCamber !== null && maxCamber > bounds.maxCamber + 1e-12) {
    throw new ServiceError(
      'TARGET_UNACHIEVABLE',
      `Meeting the target needs max camber ${trunc(maxCamber)}, above the allowed ` +
        `${bounds.maxCamber}; relax bounds.maxCamber if the section is intentionally extreme`,
      {
        maxCamber,
        bound: bounds.maxCamber,
        hint: 'Pass bounds.maxCamber (or null to disable the guard) to override the default envelope.',
      },
    );
  }
  if (bounds.maxSlope !== null && maxSlope > bounds.maxSlope + 1e-12) {
    throw new ServiceError(
      'TARGET_UNACHIEVABLE',
      `Meeting the target needs max camber slope |dz/dx| = ${trunc(maxSlope)}, above the allowed ` +
        `${bounds.maxSlope}; relax bounds.maxSlope if the section is intentionally extreme`,
      {
        maxSlope,
        bound: bounds.maxSlope,
        hint: 'Pass bounds.maxSlope (or null to disable the guard) to override the default envelope.',
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Spectrum helpers                                                    */
/* ------------------------------------------------------------------ */

/** Recover b_0..b_N from fitted unknowns c = [A0, b_1..b_N]. */
function bFromCoefficients(c: Float64Array, alpha: number, N: number): number[] {
  const b = new Array<number>(N + 1).fill(0);
  b[0] = alpha - c[0]; // m_0 = alpha - A_0
  for (let n = 1; n <= N; n += 1) b[n] = c[n];
  return b;
}

/** eta(theta) = sum b_n cos(n theta). */
function slopeFromSpectrum(theta: number, b: number[], N: number): number {
  let acc = b[0];
  for (let n = 1; n <= N; n += 1) acc += b[n] * Math.cos(n * theta);
  return acc;
}

/**
 * z(theta) = (1/2) int_0^theta eta(t) sin t dt, with z(0) = 0.
 *
 * Closed-form antiderivatives (the (cos((n-1)theta) - 1) sign is
 * essential: cos(nt) sin t integrates to sin((n+1)t)/2(n+1) minus
 * sin((n-1)t)/2(n-1), and the definite integral from 0 carries a -1):
 *   n = 0:  b_0 (1 - cos theta)/2
 *   n = 1:  b_1 sin^2(theta)/4
 *   n >= 2: (b_n/4)[ (1-cos((n+1)theta))/(n+1)
 *                   + (cos((n-1)theta)-1)/(n-1) ]
 */
function camberZFromSpectrum(theta: number, b: number[], N: number): number {
  let z = (b[0] * (1 - Math.cos(theta))) / 2;
  z += (b[1] * Math.sin(theta) * Math.sin(theta)) / 4;
  for (let n = 2; n <= N; n += 1) {
    const term =
      (1 - Math.cos((n + 1) * theta)) / (n + 1) +
      (Math.cos((n - 1) * theta) - 1) / (n - 1);
    z += (b[n] * term) / 4;
  }
  return z;
}

/** z(1) = b_0 + sum_{even n>=2} b_n/(1-n^2). */
function trailingEdgeGap(b: number[]): number {
  let gap = b[0];
  for (let n = 2; n < b.length; n += 2) gap += b[n] / (1 - n * n);
  return gap;
}

function loadingFromSpectrum(theta: number, a0: number, b: number[], N: number): number {
  let series = 0;
  for (let n = 1; n <= N; n += 1) series += b[n] * Math.sin(n * theta);
  return (4 * a0 * (1 + Math.cos(theta))) / Math.sin(theta) + 4 * series;
}

/** Evaluate Delta Cp through the FORWARD model (its own moment integrals). */
function deltaCpFromModel(
  model: ReturnType<typeof buildCamberModel>,
  alpha: number,
  theta: number,
): number {
  const m0 = model.cosineMoment(0);
  const a0 = alpha - m0;
  let series = 0;
  let sinPrev = 0;
  let sinCur = Math.sin(theta);
  const twoCos = 2 * Math.cos(theta);
  for (let n = 1; n <= LOADING_EVAL_HARMONICS; n += 1) {
    const an = 2 * model.cosineMoment(n);
    series += an * sinCur;
    const sinNext = twoCos * sinCur - sinPrev;
    sinPrev = sinCur;
    sinCur = sinNext;
  }
  return (4 * a0 * (1 + Math.cos(theta))) / Math.sin(theta) + 4 * series;
}

/** Cubic z(x) for a spectrum that only contains b_0, b_1, b_2. */
function polynomialFromLowHarmonics(b: number[]): CamberDef {
  const b0 = b[0];
  const b1 = b[1];
  const b2 = b[2] ?? 0;
  return {
    kind: 'polynomial',
    coefficients: [0, b0 + b1 + b2, -(b1 + 4 * b2), (8 / 3) * b2],
  };
}

/** Sample the integrated spectrum on a cosine-spaced grid (dense at both
 *  edges); the points representation is then ordinary piecewise-linear
 *  camber that the forward evaluator integrates segment by segment. */
function pointsFromSpectrum(b: number[], count: number): CamberDef {
  const N = b.length - 1;
  const points: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (i * Math.PI) / (count - 1);
    points.push({ x: thetaToX(theta), z: camberZFromSpectrum(theta, b, N) });
  }
  return { kind: 'points', points };
}

/* ------------------------------------------------------------------ */
/* Loading sample validation                                           */
/* ------------------------------------------------------------------ */

/**
 * Structural shape is zod-checked; here we enforce the mathematical
 * admissibility the solver needs BEFORE fitting:
 *  - at least 8 samples (too sparse to locate even the lowest harmonics);
 *  - strictly increasing chordwise position (in either coordinate);
 *  - interior points only (theta = 0 carries the LE singularity,
 *    theta = pi gives 0/0);
 *  - finite loading values (finite numbers only).
 */
function normaliseLoadingSamples(raw: LoadingCoordinate[]): NormalisedLoadingSample[] {
  if (raw.length < 8) {
    throw new ServiceError(
      'INVALID_LOADING',
      `A loading target needs at least 8 chordwise samples to locate the lowest Glauert ` +
        `harmonics, got ${raw.length}`,
      { count: raw.length, minimum: 8 },
    );
  }
  let coordinate: 'x' | 'theta' | null = null;
  const samples: NormalisedLoadingSample[] = raw.map((s) => {
    if ('x' in s) {
      if (coordinate === 'theta') {
        throw new ServiceError(
          'INVALID_LOADING',
          'Loading samples must all use the same coordinate (x or theta), not a mix',
        );
      }
      coordinate = 'x';
      return { theta: xToTheta(s.x), x: s.x, deltaCp: s.deltaCp };
    }
    if (coordinate === 'x') {
      throw new ServiceError(
        'INVALID_LOADING',
        'Loading samples must all use the same coordinate (x or theta), not a mix',
      );
    }
    coordinate = 'theta';
    return { theta: s.theta, x: thetaToX(s.theta), deltaCp: s.deltaCp };
  });

  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (!Number.isFinite(s.deltaCp)) {
      throw new ServiceError('INVALID_LOADING', 'Every loading sample must have a finite deltaCp', {
        index: i,
      });
    }
    if (!(s.x > 0 && s.x < 1)) {
      throw new ServiceError(
        'INVALID_LOADING',
        `Loading sample position must be strictly inside (0, 1); the endpoints carry the ` +
          `leading-edge singularity and the 0/0 trailing-edge point (violation at index ${i}, x=${s.x})`,
        { index: i, x: s.x },
      );
    }
    if (i > 0 && !(s.theta > samples[i - 1].theta)) {
      throw new ServiceError(
        'INVALID_LOADING',
        `Loading samples must be strictly increasing chordwise (violation at index ${i})`,
        { index: i, previousX: samples[i - 1].x, x: s.x },
      );
    }
  }
  return samples;
}

/* ------------------------------------------------------------------ */
/* Equality-constrained least squares (KKT)                            */
/* ------------------------------------------------------------------ */

/**
 * Trailing-edge closure z(1) = b0 + sum_{even n>=2} b_n/(1-n^2) = 0.
 * With b0 = alpha - A0 and unknowns c = [A0, b_1, ..., b_N] this is the
 * linear equality   -A0 + sum_{even} b_n/(1-n^2) = -alpha.
 */
function closureConstraint(
  alpha: number,
  K: number,
  N: number,
): { row: Float64Array; rhs: number } {
  const row = new Float64Array(K);
  row[0] = -1;
  for (let n = 2; n <= N; n += 2) row[n] = 1 / (1 - n * n);
  return { row, rhs: -alpha };
}

/** Minimise ||Phi c - y||^2 (given its normal equations) subject to the
 *  linear equalities E c = f, by solving the KKT system. */
function solveWithConstraints(
  HtH: Float64Array[],
  Hty: Float64Array,
  K: number,
  constraints: Array<{ row: Float64Array; rhs: number }>,
): Float64Array {
  const q = constraints.length;
  const size = K + q;
  const kkt = matrix(size, size);
  const rhs = new Float64Array(size);
  for (let i = 0; i < K; i += 1) {
    for (let j = 0; j < K; j += 1) kkt[i][j] = 2 * HtH[i][j];
    rhs[i] = 2 * Hty[i];
    for (let e = 0; e < q; e += 1) {
      kkt[i][K + e] = constraints[e].row[i];
      kkt[K + e][i] = constraints[e].row[i];
    }
  }
  for (let e = 0; e < q; e += 1) rhs[K + e] = constraints[e].rhs;
  return gaussianSolve(kkt, rhs, size).subarray(0, K);
}

/* ------------------------------------------------------------------ */
/* Small dense linear algebra (partial-pivoted Gaussian elimination)   */
/* ------------------------------------------------------------------ */

function matrix(rows: number, cols: number): Float64Array[] {
  const A: Float64Array[] = [];
  for (let i = 0; i < rows; i += 1) A.push(new Float64Array(cols));
  return A;
}

/** Deep copy of a dense row-major matrix (gaussianSolve destroys its A). */
function cloneMatrix(A: Float64Array[]): Float64Array[] {
  return A.map((row) => row.slice());
}

function matTMat(A: Float64Array[], m: number, k: number): Float64Array[] {
  const C = matrix(k, k);
  for (let i = 0; i < k; i += 1) {
    for (let j = i; j < k; j += 1) {
      let acc = 0;
      for (let r = 0; r < m; r += 1) acc += A[r][i] * A[r][j];
      C[i][j] = acc;
      C[j][i] = acc;
    }
  }
  return C;
}

function matTVec(A: Float64Array[], v: Float64Array, m: number, k: number): Float64Array {
  const c = new Float64Array(k);
  for (let i = 0; i < k; i += 1) {
    let acc = 0;
    for (let r = 0; r < m; r += 1) acc += A[r][i] * v[r];
    c[i] = acc;
  }
  return c;
}

/** Solve A x = b in place (A and b are consumed). */
function gaussianSolve(Ainput: Float64Array[], binput: Float64Array, n: number): Float64Array {
  const A = Ainput;
  const b = binput;
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-14) {
      throw new ServiceError('INTERNAL', 'Inverse design fit produced a singular system');
    }
    if (piv !== col) {
      const tr = A[piv];
      A[piv] = A[col];
      A[col] = tr;
      const tb = b[piv];
      b[piv] = b[col];
      b[col] = tb;
    }
    for (let r = col + 1; r < n; r += 1) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c += 1) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let acc = b[i];
    for (let j = i + 1; j < n; j += 1) acc -= A[i][j] * x[j];
    x[i] = acc / A[i][i];
  }
  return x;
}

/* ------------------------------------------------------------------ */

function clampPointCount(samples: number | undefined): number {
  if (samples === undefined) return DEFAULT_OUTPUT_POINTS;
  return Math.max(MIN_OUTPUT_POINTS, Math.min(MAX_OUTPUT_POINTS, Math.floor(samples)));
}

function maxAbs(b: number[], from: number): number {
  let m = 0;
  for (let n = from; n < b.length; n += 1) if (Math.abs(b[n]) > m) m = Math.abs(b[n]);
  return m;
}

function trunc(v: number): string {
  return Number(v.toFixed(6)).toString();
}
