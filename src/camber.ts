/**
 * Camber-line construction and validation.
 *
 * Responsibilities (kept separate from HTTP and from the aerodynamic kernel):
 *   - reject ill-formed geometry BEFORE any math runs, with typed errors;
 *   - build a CamberModel that reports dz/dx as a function of theta and
 *     evaluates the cosine moments used by thin-airfoil theory.
 *
 * Discrete point lines are piecewise linear, so dz/dx is constant on each
 * segment and every cosine moment is integrated EXACTLY (closed-form
 * segment contributions) rather than sampled numerically.
 */

import { CamberDef, CamberModel, PointCamber, PolynomialCamber, xToTheta } from './types';
import { ServiceError } from './errors';

const SIMPSON_SUBDIVISIONS = 2001; // must be even; odd number of nodes
const ENDPOINT_TOLERANCE = 1e-6;

/**
 * Validate a camber definition and construct its model.
 * Throws ServiceError with a specific code on any non-conforming geometry.
 */
export function buildCamberModel(def: CamberDef): CamberModel {
  if (def === null || typeof def !== 'object') {
    throw new ServiceError('INVALID_REQUEST', 'Camber definition must be an object');
  }
  if (def.kind === 'polynomial') {
    return buildPolynomial(def);
  }
  if (def.kind === 'points') {
    return buildPoints(def);
  }
  throw new ServiceError(
    'INVALID_REQUEST',
    "Camber definition 'kind' must be 'polynomial' or 'points'",
    { received: (def as { kind?: unknown }).kind },
  );
}

/* ------------------------------------------------------------------ */
/* Polynomial camber                                                   */
/* ------------------------------------------------------------------ */

function buildPolynomial(def: PolynomialCamber): CamberModel {
  if (!Array.isArray(def.coefficients)) {
    throw new ServiceError('INVALID_POLYNOMIAL', 'Polynomial camber requires a coefficients array');
  }
  const coeffs = def.coefficients;
  if (coeffs.length === 0) {
    throw new ServiceError('INVALID_POLYNOMIAL', 'Polynomial camber needs at least one coefficient');
  }
  for (const c of coeffs) {
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      throw new ServiceError('INVALID_POLYNOMIAL', 'Every polynomial coefficient must be a finite number', {
        coefficients: coeffs,
      });
    }
  }

  // Drop trailing zero coefficients (they carry no information).
  let n = coeffs.length;
  while (n > 1 && coeffs[n - 1] === 0) {
    n -= 1;
  }
  const trimmed = coeffs.slice(0, n);

  // Derivative coefficients: z(x) = sum a_k x^k  =>  z'(x) = sum k a_k x^(k-1)
  const dcoeff: number[] = trimmed.map((a, k) => k * a).slice(1);

  const slopeAt = (x: number): number => evalPoly(dcoeff, x);

  return {
    def: { kind: 'polynomial', coefficients: trimmed.slice() },
    slopeAt,
    cosineMoment: (m: number) =>
      simpsonAverage((theta) => slopeAt((1 - Math.cos(theta)) / 2) * Math.cos(m * theta)),
    isZero: () => dcoeff.every((c) => c === 0),
  };
}

function evalPoly(coeffs: number[], x: number): number {
  // Horner evaluation of ascending-power coefficient list.
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i -= 1) {
    y = y * x + (coeffs[i] ?? 0);
  }
  return y;
}

/* ------------------------------------------------------------------ */
/* Discrete-point camber                                               */
/* ------------------------------------------------------------------ */

function buildPoints(def: PointCamber): CamberModel {
  if (!Array.isArray(def.points)) {
    throw new ServiceError('TOO_FEW_POINTS', 'Point camber requires a points array');
  }
  const raw = def.points;
  if (raw.length < 2) {
    throw new ServiceError(
      'TOO_FEW_POINTS',
      `A camber line needs at least 2 discrete samples, got ${raw.length}`,
      { count: raw.length },
    );
  }
  for (const p of raw) {
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof p.x !== 'number' ||
      typeof p.z !== 'number' ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.z)
    ) {
      throw new ServiceError('INVALID_REQUEST', 'Every camber sample must be { x: number, z: number }');
    }
  }

  // Chord handling:
  //  - chord given: must be positive and finite, then both x and z are
  //    divided by chord (the dimensionless slope dz/dx must be normalised);
  //  - chord absent: x and z must already span (within tolerance) [0, 1].
  let scale = 1;
  if (def.chord !== undefined) {
    if (typeof def.chord !== 'number' || !Number.isFinite(def.chord) || def.chord <= 0) {
      throw new ServiceError('INVALID_CHORD', 'Chord must be a positive finite number when supplied', {
        chord: def.chord,
      });
    }
    scale = def.chord;
  }

  // Strict monotonic increase is checked on the ORIGINAL x values so the
  // error message points at what the caller actually sent.
  for (let i = 1; i < raw.length; i += 1) {
    if (!(raw[i].x > raw[i - 1].x)) {
      throw new ServiceError(
        'NON_MONOTONIC_X',
        `Discrete camber samples must be strictly increasing in x (violation at index ${i})`,
        { index: i, previousX: raw[i - 1].x, x: raw[i].x },
      );
    }
  }

  // Normalise by chord. Both coordinates are divided by chord: scaling only
  // x would leave z in physical units and corrupt the (dimensionless) slope
  // dz/dx that thin-airfoil theory consumes.
  let pts = raw.map((p) => ({ x: p.x / scale, z: p.z / scale }));

  if (def.chord === undefined) {
    // No scaling information: require the data to already be normalised.
    const x0 = pts[0].x;
    const xN = pts[pts.length - 1].x;
    if (Math.abs(x0) > ENDPOINT_TOLERANCE || Math.abs(xN - 1) > ENDPOINT_TOLERANCE) {
      throw new ServiceError(
        'CHORD_NOT_NORMALIZED',
        'Camber samples do not span x in [0, 1] and no chord length was supplied for scaling',
        { xLeadingEdge: raw[0].x, xTrailingEdge: raw[raw.length - 1].x },
      );
    }
    // Snap near-exact endpoints onto 0 and 1.
    pts = pts.map((p, i) => ({
      x: i === 0 ? 0 : i === pts.length - 1 ? 1 : p.x,
      z: p.z,
    }));
  } else {
    const x0 = pts[0].x;
    const xN = pts[pts.length - 1].x;
    if (x0 < -ENDPOINT_TOLERANCE || xN > 1 + ENDPOINT_TOLERANCE) {
      throw new ServiceError(
        'CHORD_NOT_NORMALIZED',
        'Scaled camber samples fall outside x in [0, 1]; check the supplied chord',
        { scaledLeadingEdge: x0, scaledTrailingEdge: xN, chord: def.chord },
      );
    }
    if (Math.abs(x0) <= ENDPOINT_TOLERANCE) pts[0] = { x: 0, z: pts[0].z };
    if (Math.abs(xN - 1) <= ENDPOINT_TOLERANCE) pts[pts.length - 1] = { x: 1, z: pts[pts.length - 1].z };
  }

  // Segment data: x edges and constant slope dz/dx per segment.
  const edges = pts.map((p) => p.x);
  const slopes: number[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dx = pts[i + 1].x - pts[i].x;
    slopes.push((pts[i + 1].z - pts[i].z) / dx);
  }

  const slopeAt = (x: number): number => {
    if (x <= edges[0]) return slopes[0];
    if (x >= edges[edges.length - 1]) return slopes[slopes.length - 1];
    let lo = 0;
    let hi = edges.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x < edges[mid]) hi = mid;
      else lo = mid;
    }
    return slopes[lo];
  };

  const cosineMoment = (m: number): number => {
    // M_m = (1/pi) sum over segments [x_i, x_{i+1}] with slope s:
    //   s * integral_{theta_i}^{theta_{i+1}} cos(m theta) d theta
    // which has an elementary antiderivative for every m >= 0.
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const tA = xToTheta(edges[i]);
      const tB = xToTheta(edges[i + 1]);
      acc += slopes[i] * integralCos(m, tA, tB);
    }
    return acc / Math.PI;
  };

  // Zero (symmetric) line: every sample lies at z = 0, i.e. no constant
  // vertical offset either (a pure offset would still give zero slope, but
  // we keep the distinction explicit).
  const zero = pts.every((p) => p.z === 0);

  return {
    def: {
      kind: 'points',
      points: pts.map((p) => ({ x: p.x, z: p.z })),
      ...(def.chord !== undefined ? { chord: def.chord } : {}),
    },
    slopeAt,
    cosineMoment,
    isZero: () => zero,
  };
}

/** integral_a^b cos(m t) dt in closed form (m = 0 handled separately). */
function integralCos(m: number, a: number, b: number): number {
  if (m === 0) return b - a;
  return (Math.sin(m * b) - Math.sin(m * a)) / m;
}

/* ------------------------------------------------------------------ */
/* Numerical quadrature for polynomial camber                          */
/* ------------------------------------------------------------------ */

/** (1/pi) * integral_0^pi f(theta) d theta by composite Simpson. */
function simpsonAverage(f: (theta: number) => number): number {
  const N = SIMPSON_SUBDIVISIONS - 1; // even number of intervals
  const h = Math.PI / N;
  let sum = f(0) + f(Math.PI);
  for (let i = 1; i < N; i += 1) {
    const w = i % 2 === 0 ? 2 : 4;
    sum += w * f(i * h);
  }
  return (sum * h) / 3 / Math.PI;
}
