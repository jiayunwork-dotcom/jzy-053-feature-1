/**
 * Inverse camber-line design under thin-airfoil theory.
 *
 * The FORWARD service goes geometry -> aerodynamics (see analyze.ts). This
 * module goes the other way: aerodynamic TARGETS -> a camber line that
 * realizes them.
 *
 * Supported target tiers (any combination is resolved to one of them):
 *
 *   1. lift only:        { alpha, cl }                       (reference AoA)
 *   2. lift + moment:    { alpha, cl, cmQuarter }            (Cm pinned too)
 *   3. loading shape:    { alpha, loading: [{x, deltaCp}] }  (a chordwise
 *                         dimensionless Delta Cp trajectory)
 *
 * Why the inverse problem is under-determined, and how the pick is unique
 * ------------------------------------------------------------------------
 * Thin-airfoil quantities only ever see the camber SLOPE eta(theta) = dz/dx
 * through its cosine moments
 *
 *     A_0 = alpha - m_0,   A_n = 2 m_n,   m_n = (1/pi) int eta cos(n theta)
 *
 * so infinitely many slope fields share the same Cl (and even the same
 * Cl + Cm). We pick the unique solution by a PHYSICAL regularisation that is
 * documented with every answer:
 *
 *     MINIMUM SLOPE ENERGY  (least bending-energy, Riesz / min-norm) camber
 *     subject to the aerodynamic constraints AND to a closed trailing edge.
 *
 * Slope energy  E = (1/pi) int_0^pi eta(theta)^2 d theta  is the leading
 * term of the thin-airfoil mean-camber-line bending penalty; minimising it
 * selects the SMOOTHEST, LOWEST-ORDER admissible line. The constraints are
 * linear functionals of eta (Cl, Cm, and the Kutta closure int eta sin = 0),
 * so the minimiser is a finite linear combination of their representers:
 *
 *     eta(theta) = sum_j mu_j r_j(theta),   S mu = target
 *
 * with the reduced Gram matrix  S_jk = (pi/2) int w_j w_k  for the
 * constraint weight functions w_j. This is deterministic (no search, no
 * randomness) and the same target always yields the same line.
 *
 * For a loading-shape target the sampled Delta Cp is first reduced, by a
 * weighted sin(theta) least-squares fit, to a finite Glauert harmonic set
 * (a fixed low order N = the documented regularisation), then synthesised
 * the same way.
 *
 * The returned geometry is ALWAYS a discrete-point camber (one of the two
 * existing representations), built so that each linear segment's constant
 * slope is the exact cell-average of the minimising eta: the forward
 * evaluator then reclaims the targets to tight tolerance.
 *
 * Pure functions, no shared mutable state: concurrent requests build
 * independent local arrays and can never interleave.
 */

import { CamberDef } from './types';
import { MAX_ALPHA_RAD, analyze } from './analyze';
import { buildCamberModel } from './camber';
import { ServiceError } from './errors';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Number of theta segments used to synthesise the discrete camber. */
const SYNTH_SEGMENTS = 512;

/** Glauert harmonics retained for a loading-shape target (regularisation). */
export const LOADING_FIT_ORDER = 8;

/** Minimum number of loading samples accepted for a shape target. */
export const MIN_LOADING_SAMPLES = 8;

/** Default closed-loop verification tolerances (forward re-evaluation). */
export const DEFAULT_TOLERANCE = {
  cl: 2e-3,
  cmQuarter: 5e-4,
} as const;

/** Physical thin-airfoil guard rails for the synthesised geometry. */
const MAX_SLOPE = 0.6; // |dz/dx| above this is well outside thin-airfoil range
const MAX_CAMBER = 0.2; // max |z| above ~20% chord is not a "thin" airfoil

/** Composite Simpson: (2/pi) int_0^pi f d theta, M even intervals. */
function innerIntegral(f: (theta: number) => number, M = 4000): number {
  const h = Math.PI / M;
  let s = f(0) + f(Math.PI);
  for (let i = 1; i < M; i += 1) {
    s += (i % 2 === 1 ? 4 : 2) * f(i * h);
  }
  return (s * h) / 3;
}

/* ------------------------------------------------------------------ */
/* Tiny dense linear algebra (matrices are at most ~12x12)             */
/* ------------------------------------------------------------------ */

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  // Augmented matrix with partial pivoting.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i += 1) {
    let p = i;
    for (let k = i + 1; k < n; k += 1) {
      if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    }
    if (Math.abs(M[p][i]) < 1e-14) {
      throw new ServiceError('TARGET_INCONSISTENT', 'The supplied targets are linearly dependent or contradictory', {
        pivot: i,
      });
    }
    [M[i], M[p]] = [M[p], M[i]];
    for (let k = i + 1; k < n; k += 1) {
      const factor = M[k][i] / M[i][i];
      if (factor !== 0) {
        for (let j = i; j <= n; j += 1) M[k][j] -= factor * M[i][j];
      }
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j += 1) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x;
}

/** Solve H x = g for symmetric positive-definite H via Cholesky. */
function solveSPD(H: number[][], g: number[]): number[] {
  const n = H.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = H[i][j];
      for (let k = 0; k < j; k += 1) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 1e-30)) {
          throw new ServiceError('LOADING_MALFORMED', 'The loading samples do not determine a stable harmonic fit');
        }
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let s = g[i];
    for (let k = 0; k < i; k += 1) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i];
    for (let k = i + 1; k < n; k += 1) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/* ------------------------------------------------------------------ */
/* Constraint weights and representers                                 */
/* ------------------------------------------------------------------ */

/**
 * Every aerodynamic target is a linear functional of the slope eta:
 *
 *   L(eta) = alpha_L0 = alpha - Cl/(2 pi) = (1/pi) int eta (1 - cos theta)
 *          = int w_L eta,   w_L = (1 - cos theta)/pi
 *
 *   M(eta) = Cm_{c/4} = (pi/2)(m_2 - m_1) = int w_M eta
 *          w_M = (cos 2theta - cos theta)/2
 *
 *   C(eta) = int eta sin theta = 0          (closed trailing edge, z(1)=0)
 *          w_C = sin theta / pi   (normalised so the constraint value is 0)
 *
 * The Riesz representer under <f,g> = (2/pi) int f g is r = (pi/2) w.
 * We expand each representer on the fixed harmonic basis
 * {1, cos theta, cos 2theta, sin theta}:
 */
type ConstraintKind = 'L' | 'M' | 'C';

/** Human-readable names attached to the returned criterion. */
const CONSTRAINT_LABEL = {
  L: 'cl_target',
  M: 'cm_quarter_target',
  C: 'closed_trailing_edge',
} as const;

const representerCoef: Record<ConstraintKind, [number, number, number, number]> = {
  // r_L = (1/2)(1 - cos theta)
  L: [0.5, -0.5, 0, 0],
  // r_M = (pi/4)(cos 2theta - cos theta)
  M: [0, -Math.PI / 4, Math.PI / 4, 0],
  // r_C = (1/2) sin theta
  C: [0, 0, 0, 0.5],
};

const constraintWeight: Record<ConstraintKind, (theta: number) => number> = {
  L: (t) => (1 - Math.cos(t)) / Math.PI,
  M: (t) => (Math.cos(2 * t) - Math.cos(t)) / 2,
  C: (t) => Math.sin(t) / Math.PI,
};

/** Harmonic slope eta(theta) = c0 + c1 cos t + c2 cos 2t + s1 sin t. */
interface SlopeHarmonics {
  c0: number;
  c1: number;
  c2: number;
  s1: number;
}

/**
 * Minimum-slope-energy slope satisfying the given constraint kinds/values.
 * Reduced Gram  S_jk = (pi/2) int w_j w_k ; multipliers solve S mu = value;
 * the minimiser is eta = sum mu_j r_j.
 */
function minimumEnergySlope(
  constraints: Array<{ kind: ConstraintKind; value: number }>,
): SlopeHarmonics {
  const weights = constraints.map((c) => constraintWeight[c.kind]);
  const values = constraints.map((c) => c.value);

  const S = weights.map((wa) => weights.map((wb) => (Math.PI / 2) * innerIntegral((t) => wa(t) * wb(t))));
  const mu = solveLinear(S, values);

  const c = [0, 0, 0, 0];
  mu.forEach((u, j) => {
    const r = representerCoef[constraints[j].kind];
    for (let k = 0; k < 4; k += 1) c[k] += u * r[k];
  });
  return { c0: c[0], c1: c[1], c2: c[2], s1: c[3] };
}

/* ------------------------------------------------------------------ */
/* Slope -> camber synthesis (exact cell-average slopes)               */
/* ------------------------------------------------------------------ */

/** int_a^b sin theta d theta. */
function i0(a: number, b: number): number {
  return Math.cos(a) - Math.cos(b);
}

/** int_a^b sin^2 theta d theta. */
function iSinSq(a: number, b: number): number {
  return (b - a) / 2 - (Math.sin(2 * b) - Math.sin(2 * a)) / 4;
}

/**
 * int_a^b cos(n theta) sin theta d theta.
 * cos n sin = 1/2[sin((n+1)t) - sin((n-1)t)]; the n = 1 term is sin^2.
 */
function iCosSin(n: number, a: number, b: number): number {
  if (n === 1) return (Math.sin(b) * Math.sin(b) - Math.sin(a) * Math.sin(a)) / 2;
  const g = (t: number) => Math.cos((n + 1) * t) / (n + 1) - Math.cos((n - 1) * t) / (n - 1);
  return -0.5 * (g(b) - g(a));
}

/**
 * A fully-specified finite harmonic camber slope:
 *     eta(theta) = c0 + s1 sin theta + sum_{n=1..N} cn cos(n theta).
 */
interface HarmonicSlopeSpec {
  c0: number;
  s1: number;
  /** Cosine amplitudes, 1-indexed (index 0 unused). */
  cos: number[];
}

/**
 * Synthesise a closed discrete-point camber from a finite harmonic slope.
 *
 * On each theta cell the constant piecewise-linear slope is set to the
 * EXACT theta-cell average of eta, i.e. [int eta sin]/[int sin] (cells
 * degenerate at the two singular endpoints, where the midpoint value is
 * used). With cell-average slopes the discrete cosine moments of the
 * returned line match the continuous ones with high-order accuracy, and
 * z(1) = 0 analytically.
 */
function synthesizePoints(
  spec: HarmonicSlopeSpec,
  segments = SYNTH_SEGMENTS,
): { camber: Extract<CamberDef, { kind: 'points' }>; maxSlope: number; maxZ: number } {
  const { c0, s1, cos } = spec;
  const N = cos.length - 1; // highest cosine harmonic (index 0 unused)
  const eta = (t: number) => {
    let v = c0 + s1 * Math.sin(t);
    for (let n = 1; n <= N; n += 1) v += cos[n] * Math.cos(n * t);
    return v;
  };
  const dTheta = Math.PI / segments;
  const points: Array<{ x: number; z: number }> = [{ x: 0, z: 0 }];
  let z = 0;
  let maxSlope = 0;
  let maxZ = 0;

  for (let k = 0; k < segments; k += 1) {
    const a = k * dTheta;
    const b = (k + 1) * dTheta;
    const denom = i0(a, b);
    let meanSlope: number;
    if (Math.abs(denom) < 1e-10) {
      // Endpoint cells where sin theta collapses: use the cell midpoint.
      meanSlope = eta((a + b) / 2);
    } else {
      let num = c0 * denom + s1 * iSinSq(a, b);
      for (let n = 1; n <= N; n += 1) num += cos[n] * iCosSin(n, a, b);
      meanSlope = num / denom;
    }
    // dx = (cos a - cos b)/2 ; integrate z forward.
    z += meanSlope * (denom / 2);
    const x = (1 - Math.cos(b)) / 2;
    points.push({ x, z });
    maxSlope = Math.max(maxSlope, Math.abs(meanSlope));
    maxZ = Math.max(maxZ, Math.abs(z));
  }
  // Snap the trailing edge to exactly z = 0 (roundoff only).
  points[points.length - 1].z = 0;

  return { camber: { kind: 'points', points }, maxSlope, maxZ };
}


/* ------------------------------------------------------------------ */
/* Public result type                                                  */
/* ------------------------------------------------------------------ */

export interface InverseResult {
  /** The inverse-designed camber, directly consumable by /analyze. */
  camber: CamberDef;
  /** Reference angle of attack for which the targets were met (rad). */
  alpha: number;
  /** Targets the caller asked for. */
  targets: {
    cl?: number;
    cmQuarter?: number;
  };
  /**
   * The uniqueness / regularisation criterion actually used, returned with
   * every answer so the result is explainable, not arbitrary.
   */
  criterion: {
    name: 'minimum_slope_energy';
    description: string;
    /** The linear aerodynamic constraints imposed on the slope. */
    constraints: string[];
    /** Fixed harmonic order retained (loading-shape tier reports its N). */
    harmonicOrder: number;
    closedTrailingEdge: true;
    /** Discrete-point synthesis resolution. */
    segments: number;
  };
  /** Forward re-evaluation of the synthesised geometry at `alpha`. */
  verification: {
    cl: number;
    cmQuarter: number;
    /** |forward - target| per pinned quantity. */
    clError: number;
    cmQuarterError: number;
    tolerance: { cl: number; cmQuarter: number };
    passed: boolean;
    /**
     * Loading-shape tier only: weighted (sin theta) RMS residual between the
     * requested samples and the harmonic fit, both absolute and normalised by
     * the weighted RMS of the target itself. This is how closely the requested
     * TRAJECTORY (not just its integrated Cl/Cm) was reproduced.
     */
    loadingShapeFit?: {
      weightedRms: number;
      normalisedRms: number;
      samples: number;
      harmonicOrder: number;
    };
  };
  diagnostics: {
    maxCamber: number;
    maxSlope: number;
  };
}

/* ------------------------------------------------------------------ */
/* Tier 1/2: scalar targets                                            */
/* ------------------------------------------------------------------ */

export interface ScalarTarget {
  /** Reference angle of attack, RADIANS. */
  alpha: number;
  /** Desired lift coefficient at alpha. */
  cl: number;
  /** Desired quarter-chord moment (only for the lift+moment tier). */
  cmQuarter?: number;
  /**
   * Require the answer to be a SYMMETRIC (zero-camber) section. A symmetric
   * section has identically zero Cm_{c/4} for every angle of attack, so
   * combining this with a nonzero cmQuarter is a logical impossibility that
   * is rejected up front with TARGET_INCONSISTENT.
   */
  symmetric?: boolean;
  tolerance?: {
    cl?: number;
    cmQuarter?: number;
  };
}

/**
 * Inverse-design from a scalar target. With only Cl pinned the minimum-energy
 * solution uses the Cl and closure constraints; adding Cm pins one more
 * harmonic. A pinned NONZERO Cm is always realisable (camber carries it);
 * the symmetric-section paradox (zero camber demanded alongside nonzero
 * moment) does not arise here because camber is the unknown — it IS
 * synthesised. Contradiction is instead detected when Cl cannot be met
 * within the thin-airfoil angle/geometry envelope.
 */
export function designForScalars(target: ScalarTarget): InverseResult {
  const { alpha, cl } = target;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
    throw new ServiceError('INVALID_ALPHA', 'Reference angle of attack must be a finite number of radians', {
      received: String(alpha),
    });
  }
  if (typeof cl !== 'number' || !Number.isFinite(cl)) {
    throw new ServiceError('TARGET_INCONSISTENT', 'Target lift coefficient must be a finite number', {
      received: String(cl),
    });
  }
  const cm = target.cmQuarter;
  if (cm !== undefined && (typeof cm !== 'number' || !Number.isFinite(cm))) {
    throw new ServiceError('TARGET_INCONSISTENT', 'Target moment coefficient must be a finite number', {
      received: String(cm),
    });
  }
  if (Math.abs(alpha) > MAX_ALPHA_RAD + 1e-12) {
    throw new ServiceError(
      'TARGET_UNREALIZABLE',
      'Reference angle of attack exceeds the 15-degree thin-airfoil validity limit',
      { alphaRadians: alpha, limitRadians: MAX_ALPHA_RAD },
    );
  }

  // Explicit paradox: a symmetric section is flat (eta = 0), so its
  // quarter-chord moment is IDENTICALLY zero at every angle of attack. A
  // nonzero pinned moment cannot be produced by ANY amount of angle of
  // attack. Detect this contradiction before any geometry is synthesised.
  if (target.symmetric === true && cm !== undefined && Math.abs(cm) > 1e-12) {
    throw new ServiceError(
      'TARGET_INCONSISTENT',
      'A symmetric (zero-camber) section has identically zero Cm,c/4 at every angle of attack; ' +
        'a nonzero moment target cannot be met by a symmetric section',
      {
        requestedCmQuarter: cm,
        symmetricSectionCmQuarter: 0,
        reason: 'Cm,c/4 depends only on camber harmonics (A2 - A1); angle of attack cannot change it',
      },
    );
  }

  // Symmetric request: the only admissible camber is the flat line; it can
  // meet a pure lift target exactly iff that lift equals 2 pi alpha.
  if (target.symmetric === true) {
    return symmetricResult(alpha, cl, target.tolerance);
  }

  // Functional TARGET VALUES (what int w eta must equal).
  const alphaL0Target = alpha - cl / (2 * Math.PI); // L(eta)
  const constraints: Array<{ kind: ConstraintKind; value: number }> = [{ kind: 'L', value: alphaL0Target }];
  if (cm !== undefined) constraints.push({ kind: 'M', value: cm });
  constraints.push({ kind: 'C', value: 0 });

  const h = minimumEnergySlope(constraints);

  const built = synthesizePoints({ c0: h.c0, s1: h.s1, cos: [0, h.c1, h.c2] });
  const labels = constraints.map((c) => CONSTRAINT_LABEL[c.kind]);
  const result = finalizeScalar(built.camber, alpha, cl, cm, target.tolerance, labels, 2);
  guardThinAirfoil(result, built.maxSlope, built.maxZ, cl, cm);
  assertToleranceMet(result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Tier 3: loading-shape target                                        */
/* ------------------------------------------------------------------ */

export interface LoadingSample {
  x: number;
  deltaCp: number;
}

export interface LoadingTarget {
  /** Reference angle of attack, RADIANS. */
  alpha: number;
  /** Chordwise dimensionless loading samples, x strictly increasing in (0,1). */
  loading: LoadingSample[];
  /** Fixed harmonic order of the least-squares reduction (default 8). */
  order?: number;
  tolerance?: {
    cl?: number;
    cmQuarter?: number;
  };
}

/**
 * Inverse-design from a desired chordwise Delta Cp trajectory.
 *
 * The samples are reduced to Glauert harmonics by a WEIGHTED least-squares
 * fit (weight sin theta, which is exactly the Cl-integration measure and
 * tames the leading-edge singular column), then synthesised with closed TE.
 * The weighted fit is the loading-tier form of the minimum-energy rule: it
 * keeps the lowest fixed harmonic order that reproduces the samples.
 */
export function designForLoading(target: LoadingTarget): InverseResult {
  const { alpha } = target;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
    throw new ServiceError('INVALID_ALPHA', 'Reference angle of attack must be a finite number of radians', {
      received: String(alpha),
    });
  }
  if (Math.abs(alpha) > MAX_ALPHA_RAD + 1e-12) {
    throw new ServiceError(
      'TARGET_UNREALIZABLE',
      'Reference angle of attack exceeds the 15-degree thin-airfoil validity limit',
      { alphaRadians: alpha, limitRadians: MAX_ALPHA_RAD },
    );
  }

  const samples = validateLoadingSamples(target.loading);
  const order = target.order ?? LOADING_FIT_ORDER;
  if (!Number.isInteger(order) || order < 2 || order > LOADING_FIT_ORDER) {
    throw new ServiceError('TARGET_INCONSISTENT', `Harmonic order must be an integer in [2, ${LOADING_FIT_ORDER}]`, {
      order,
    });
  }

  // Map x -> theta and assemble the weighted least-squares system.
  const data = samples.map((s) => ({
    theta: Math.acos(Math.min(1, Math.max(-1, 1 - 2 * s.x))),
    y: s.deltaCp,
  }));
  const dim = order + 1;
  // Delta Cp = 4 A0 (1+cos)/sin + 4 sum_{n>=1} An sin(n theta).
  const H = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const g = new Array<number>(dim).fill(0);
  for (const { theta: t, y } of data) {
    const w = Math.sin(t);
    const row = [4 * (1 + Math.cos(t)) / Math.sin(t)];
    for (let n = 1; n <= order; n += 1) row.push(4 * Math.sin(n * t));
    for (let p = 0; p < dim; p += 1) {
      const v = row[p] * w;
      g[p] += v * (y * w);
      for (let q = 0; q < dim; q += 1) H[p][q] += v * row[q] * w;
    }
  }
  const A = solveSPD(H, g); // A[0..order] Glauert coefficients

  // The fitted harmonics need not close the trailing edge. Enforce the
  // Kutta closure of the camber SLOPE exactly:
  //   int eta sin = 2 m0 + sum_{even n>=2} A_n * (-2/(n^2-1)) = 0
  // determines m0 from the even cosine harmonics, overriding the A0
  // implied by the point fit. The angle of attack then absorbs the
  // difference: the returned line realises the requested SHAPE at alpha.
  let m0 = 0;
  for (let n = 2; n <= order; n += 2) {
    m0 += (A[n] ?? 0) / (n * n - 1); // sum A_n/(n^2-1); see factor 2s below
  }
  const cos = [0, ...A.slice(1)];
  const built = synthesizePoints({ c0: m0, s1: 0, cos });
  // Effective Glauert A0 of the closed slope is alpha - m0.
  const A0Closed = alpha - m0;
  const clFit = 2 * Math.PI * (A0Closed + (A[1] ?? 0) / 2);
  const cmFit = (Math.PI / 4) * ((A[2] ?? 0) - (A[1] ?? 0));

  // Weighted residual of the CLOSED solution's loading against the samples.
  // The closure correction replaces the fitted A0 by A0Closed; evaluate the
  // trajectory with that effective A0 so the reported fit is the one the
  // synthesised camber actually produces.
  let numSq = 0;
  let denSq = 0;
  for (const { theta: t, y } of data) {
    let pred = 4 * A0Closed * (1 + Math.cos(t)) / Math.sin(t);
    for (let n = 1; n <= order; n += 1) pred += 4 * (A[n] ?? 0) * Math.sin(n * t);
    const w = Math.sin(t);
    numSq += w * w * (pred - y) * (pred - y);
    denSq += w * w * y * y;
  }
  const weightedRms = Math.sqrt(numSq / data.length);
  const targetRms = Math.sqrt(denSq / data.length);
  const normalisedRms = targetRms > 1e-12 ? weightedRms / targetRms : weightedRms;

  const result = finalizeScalar(
    built.camber,
    alpha,
    clFit,
    cmFit,
    target.tolerance,
    ['loading_least_squares', CONSTRAINT_LABEL.C],
    order,
  );
  result.verification.loadingShapeFit = {
    weightedRms,
    normalisedRms,
    samples: data.length,
    harmonicOrder: order,
  };
  guardThinAirfoil(result, built.maxSlope, built.maxZ, clFit, cmFit);
  assertToleranceMet(result);
  return result;
}

/**
 * Validate a loading sample list BEFORE any solving runs:
 *  - array present and every entry finite;
 *  - enough samples to fit the harmonics stably;
 *  - x strictly increasing and inside the open chord (0, 1).
 */
function validateLoadingSamples(raw: unknown): LoadingSample[] {
  if (!Array.isArray(raw)) {
    throw new ServiceError('LOADING_MALFORMED', 'Loading target must be an array of { x, deltaCp } samples');
  }
  if (raw.length < MIN_LOADING_SAMPLES) {
    throw new ServiceError(
      'LOADING_TOO_FEW_SAMPLES',
      `A loading-shape target needs at least ${MIN_LOADING_SAMPLES} chordwise samples, got ${raw.length}`,
      { count: raw.length, minimum: MIN_LOADING_SAMPLES },
    );
  }
  const samples: LoadingSample[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const p = raw[i];
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof (p as LoadingSample).x !== 'number' ||
      typeof (p as LoadingSample).deltaCp !== 'number' ||
      !Number.isFinite((p as LoadingSample).x) ||
      !Number.isFinite((p as LoadingSample).deltaCp)
    ) {
      throw new ServiceError('LOADING_MALFORMED', 'Every loading sample must be { x: number, deltaCp: number }', {
        index: i,
      });
    }
    const { x, deltaCp } = p as LoadingSample;
    if (!(x > 0 && x < 1)) {
      throw new ServiceError(
        'LOADING_MALFORMED',
        'Loading sample x must lie strictly inside the open chord (0, 1); endpoints are singular',
        { index: i, x },
      );
    }
    samples.push({ x, deltaCp });
  }
  for (let i = 1; i < samples.length; i += 1) {
    if (!(samples[i].x > samples[i - 1].x)) {
      throw new ServiceError(
        'LOADING_NOT_MONOTONIC',
        `Loading samples must be strictly increasing in x (violation at index ${i})`,
        { index: i, previousX: samples[i - 1].x, x: samples[i].x },
      );
    }
  }
  return samples;
}

/* ------------------------------------------------------------------ */
// Forward re-evaluation + closure (the hard requirement)
/* ------------------------------------------------------------------ */

/**
 * The flat (symmetric) camber line answer. Lift on a symmetric section is
 * exactly Cl = 2 pi alpha, so a symmetric request is honoured only when the
 * requested Cl matches; otherwise the target is unrealisable WITH the
 * symmetry restriction even though a cambered line could meet it.
 */
function symmetricResult(
  alpha: number,
  cl: number,
  tolerance: ScalarTarget['tolerance'],
): InverseResult {
  const tol = {
    cl: tolerance?.cl ?? DEFAULT_TOLERANCE.cl,
    cmQuarter: tolerance?.cmQuarter ?? DEFAULT_TOLERANCE.cmQuarter,
  };
  const camber: CamberDef = { kind: 'points', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] };
  const model = buildCamberModel(camber);
  const forward = analyze({ model, alpha }, 129);
  const clError = Math.abs(forward.cl - cl);
  if (clError > tol.cl) {
    throw new ServiceError(
      'TARGET_UNREALIZABLE',
      'A symmetric section gives exactly Cl = 2 pi alpha at the reference angle of attack; the ' +
        'requested lift cannot be reached by a symmetric section (camber would be required)',
      {
        requestedCl: cl,
        symmetricClAtAlpha: 2 * Math.PI * alpha,
        alpha,
      },
    );
  }
  return {
    camber,
    alpha,
    targets: { cl },
    criterion: {
      name: 'minimum_slope_energy',
      description: 'Symmetric section requested: the unique zero-camber (flat) line, which is the global minimum-slope-energy solution.',
      constraints: ['symmetric_section'],
      harmonicOrder: 0,
      closedTrailingEdge: true,
      segments: 1,
    },
    verification: {
      cl: forward.cl,
      cmQuarter: forward.cmQuarter,
      clError,
      cmQuarterError: Math.abs(forward.cmQuarter),
      tolerance: tol,
      passed: clError <= tol.cl && Math.abs(forward.cmQuarter) <= tol.cmQuarter,
    },
    diagnostics: { maxCamber: 0, maxSlope: 0 },
  };
}

function finalizeScalar(
  camber: CamberDef,
  alpha: number,
  clTarget: number,
  cmTarget: number | undefined,
  tolerance: ScalarTarget['tolerance'],
  constraints: string[],
  harmonicOrder: number,
): InverseResult {
  const tol = {
    cl: tolerance?.cl ?? DEFAULT_TOLERANCE.cl,
    cmQuarter: tolerance?.cmQuarter ?? DEFAULT_TOLERANCE.cmQuarter,
  };

  // HARD CLOSURE LOOP: feed the synthesised geometry back through the exact
  // forward evaluator and confirm the targets are reclaimed.
  const model = buildCamberModel(camber);
  const forward = analyze({ model, alpha }, 129);

  const clError = Math.abs(forward.cl - clTarget);
  const cmError = cmTarget === undefined ? 0 : Math.abs(forward.cmQuarter - cmTarget);
  const passed = clError <= tol.cl && (cmTarget === undefined || cmError <= tol.cmQuarter);

  return {
    camber,
    alpha,
    targets: cmTarget === undefined ? { cl: clTarget } : { cl: clTarget, cmQuarter: cmTarget },
    criterion: {
      name: 'minimum_slope_energy',
      description:
        'Unique minimum slope-energy (least bending-energy / Riesz min-norm) camber: minimises ' +
        '(1/pi) int (dz/dx)^2 d theta subject to the pinned aerodynamic targets and a closed ' +
        'trailing edge. Deterministic; selects the smoothest lowest-order admissible line.',
      constraints,
      harmonicOrder,
      closedTrailingEdge: true,
      segments: SYNTH_SEGMENTS,
    },
    verification: {
      cl: forward.cl,
      cmQuarter: forward.cmQuarter,
      clError,
      cmQuarterError: cmError,
      tolerance: tol,
      passed,
    },
    diagnostics: { maxCamber: 0, maxSlope: 0 },
  };
}

/**
 * Reject targets that thin-airfoil theory cannot deliver with a thin line:
 * if meeting the Cl target forces the geometry past the thin-airfoil
 * envelope, refuse with a typed error rather than emit a wild camber.
 */
function guardThinAirfoil(
  result: InverseResult,
  maxSlope: number,
  maxZ: number,
  cl: number,
  cm: number | undefined,
): void {
  result.diagnostics = { maxCamber: maxZ, maxSlope };
  if (!(maxSlope <= MAX_SLOPE && maxZ <= MAX_CAMBER)) {
    throw new ServiceError(
      'TARGET_UNREALIZABLE',
      'Meeting this target requires camber/slope far outside the thin-airfoil validity range; ' +
        'no physically admissible thin camber line can deliver it at the given angle of attack',
      {
        requestedCl: cl,
        ...(cm !== undefined ? { requestedCmQuarter: cm } : {}),
        producedMaxSlope: maxSlope,
        maxAllowedSlope: MAX_SLOPE,
        producedMaxCamber: maxZ,
        maxAllowedCamber: MAX_CAMBER,
      },
    );
  }
}

/**
 * Enforce the hard closed-loop guarantee: the synthesised camber must reclaim
 * every pinned target inside the requested tolerance. If it cannot (e.g. the
 * caller demanded a tolerance tighter than the synthesis resolution), this is
 * a structured failure rather than a quietly `passed:false` success.
 */
function assertToleranceMet(result: InverseResult): void {
  if (!result.verification.passed) {
    throw new ServiceError(
      'INVERSE_TOLERANCE_NOT_MET',
      'The inverse-designed camber does not reproduce the requested targets within the stated tolerance',
      {
        clError: result.verification.clError,
        cmQuarterError: result.verification.cmQuarterError,
        tolerance: result.verification.tolerance,
        achieved: { cl: result.verification.cl, cmQuarter: result.verification.cmQuarter },
        requested: result.targets,
      },
    );
  }
}
