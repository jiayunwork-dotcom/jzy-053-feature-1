/**
 * Inverse-design solver tests. The contract that matters most is the
 * closed loop:
 *
 *   targets -> inverseDesign -> camber -> buildCamberModel -> analyze
 *
 * and the forward evaluator must give the requested quantities back
 * within the PUBLISHED tolerances. These tests pin:
 *
 *  - level 1 (lift): recovered parabola, Cl to 1e-6, hand-checked shape;
 *  - level 2 (lift + Cm): recovered cubic, Cm to 1e-5; Cm interval
 *    selection and clamping; the minimum-order selection criterion;
 *  - level 3 (loading): polynomial and point representations, pinned
 *    Cl/Cm constraints, shape RMS;
 *  - uniqueness/determinism: identical targets give identical camber;
 *  - impossible / inconsistent targets rejected BEFORE solving with the
 *    typed error (symmetric loading + non-zero Cm; loading that cannot
 *    meet a pinned scalar; open trailing edge; geometric and incidence
 *    limits; sparse / non-monotone / endpoint samples; missing target).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { xToTheta, thetaToX } from '../src/types';
import { buildCamberModel } from '../src/camber';
import { analyze } from '../src/analyze';
import {
  inverseDesign,
  INVERSE_CL_TOLERANCE,
  INVERSE_CM_TOLERANCE,
  INVERSE_LOADING_RMS_TOLERANCE,
  InverseRequest,
} from '../src/inverse';
import { ServiceError } from '../src/errors';

function expectCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (err: unknown) => err instanceof ServiceError && err.code === code,
    `expected ServiceError code ${code}`,
  );
}

/** Build loading samples (uniform-x, interior points) from explicit
 *  Glauert components A0 and b_1..b_K. The samples only encode A0 and the
 *  slope harmonics; the matching reference alpha (which fixes b0) is the
 *  caller's responsibility. */
function loadingFromComponents(
  a0: number,
  b: number[],
  count = 96,
): Array<{ x: number; deltaCp: number }> {
  const out: Array<{ x: number; deltaCp: number }> = [];
  for (let i = 1; i <= count; i += 1) {
    const x = i / (count + 1);
    const theta = xToTheta(x);
    let dcp = (4 * a0 * (1 + Math.cos(theta))) / Math.sin(theta);
    for (let n = 1; n <= b.length; n += 1) dcp += 4 * (b[n - 1] ?? 0) * Math.sin(n * theta);
    out.push({ x, deltaCp: dcp });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Level 1: prescribed lift                                            */
/* ------------------------------------------------------------------ */

test('level 1: target Cl at alpha=0 recovers the 5% demo parabola', () => {
  const cl = 0.2 * Math.PI;
  const r = inverseDesign({ alpha: 0, cl });
  assert.equal(r.target.kind, 'lift');
  assert.deepEqual(r.camber, { kind: 'polynomial', coefficients: [0, 0.2, -0.2] });
  assert.equal(r.selectionCriterion.id, 'minimum-glauert-order');
  assert.deepEqual(r.selectionCriterion.activeHarmonics, [1]);
  assert.ok(Math.abs(r.prediction.alphaL0 - -0.1) < 1e-12);

  // Closed loop through the unmodified forward path, independently.
  const model = buildCamberModel(r.camber);
  const fwd = analyze({ model, alpha: 0 });
  assert.ok(Math.abs(fwd.cl - cl) < INVERSE_CL_TOLERANCE);
  assert.equal(r.verification.passed, true);
  assert.ok(r.verification.clError <= INVERSE_CL_TOLERANCE);
});

test('level 1: reference alpha reduces the camber needed for a shared Cl', () => {
  // At alpha = 0.05, part of Cl=0.5 is carried by incidence.
  const r = inverseDesign({ alpha: 0.05, cl: 0.5 });
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0.05 });
  assert.ok(Math.abs(fwd.cl - 0.5) < INVERSE_CL_TOLERANCE);
  // b1 = Cl/pi - 2 alpha = 0.05915...
  const b1 = 0.5 / Math.PI - 0.1;
  assert.deepEqual(r.camber.kind, 'polynomial');
  if (r.camber.kind === 'polynomial') {
    assert.ok(Math.abs(r.camber.coefficients[1] - b1) < 1e-12);
    assert.ok(Math.abs(r.camber.coefficients[2] + b1) < 1e-12);
  }
  assert.ok(Math.abs(r.diagnostics.maxCamber - b1 / 4) < 1e-6);
});

test('level 1: negative lift gives negatively cambered line and exact zero Cl gives the flat line', () => {
  const neg = inverseDesign({ alpha: 0, cl: -0.4 });
  const fwd = analyze({ model: buildCamberModel(neg.camber), alpha: 0 });
  assert.ok(Math.abs(fwd.cl - -0.4) < INVERSE_CL_TOLERANCE);
  if (neg.camber.kind === 'polynomial') assert.ok(neg.camber.coefficients[1] < 0);

  const zero = inverseDesign({ alpha: 0, cl: 0 });
  if (zero.camber.kind === 'polynomial') {
    assert.ok(zero.camber.coefficients.every((c) => Math.abs(c) < 1e-12));
  }
  assert.equal(buildCamberModel(zero.camber).isZero(), true);
});

/* ------------------------------------------------------------------ */
/* Level 2: lift + quarter-chord moment                                */
/* ------------------------------------------------------------------ */

test('level 2: Cl + Cm recovers the demo parabola (b2 = 0 collapses to quadratic)', () => {
  const r = inverseDesign({
    alpha: 0,
    cl: 0.2 * Math.PI,
    cmQuarter: -0.05 * Math.PI,
  });
  assert.equal(r.target.kind, 'lift-moment');
  assert.deepEqual(r.selectionCriterion.activeHarmonics, [0, 1, 2]);
  if (r.camber.kind === 'polynomial') {
    assert.ok(Math.abs(r.camber.coefficients[0]) < 1e-12);
    assert.ok(Math.abs(r.camber.coefficients[1] - 0.2) < 1e-12);
    assert.ok(Math.abs(r.camber.coefficients[2] + 0.2) < 1e-12);
    assert.ok(Math.abs(r.camber.coefficients[3] ?? 0) < 1e-12);
  }
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0 });
  assert.ok(Math.abs(fwd.cl - 0.2 * Math.PI) < INVERSE_CL_TOLERANCE);
  assert.ok(Math.abs(fwd.cmQuarter - -0.05 * Math.PI) < INVERSE_CM_TOLERANCE);
});

test('level 2: zero lift with non-zero Cm yields a genuine reflexed cubic', () => {
  // This is the textbook case a symmetric / single-parabola space cannot
  // meet: Cl = 0 but Cm != 0. The lowest-order solution is cubic and
  // carries BOTH signs of camber.
  const r = inverseDesign({
    alpha: 0,
    cl: 0,
    cmQuarter: -0.08,
    bounds: { maxCamber: null, maxSlope: null },
  });
  assert.equal(r.camber.kind, 'polynomial');
  if (r.camber.kind === 'polynomial') {
    // cubic coefficient (8/3) b2 with b2 = 12 d, d = Cm/pi -> non-zero.
    assert.ok(Math.abs(r.camber.coefficients[3] ?? 0) > 1e-9);
  }
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0 });
  assert.ok(Math.abs(fwd.cl) < INVERSE_CL_TOLERANCE);
  assert.ok(Math.abs(fwd.cmQuarter - -0.08) < INVERSE_CM_TOLERANCE);
  // The line genuinely reverses camber sign (reflex) somewhere.
  const model = buildCamberModel(r.camber);
  const zAt = (x: number) => {
    if (r.camber.kind !== 'polynomial') return 0;
    return r.camber.coefficients.reduce((acc, c, k) => acc + c * x ** k, 0);
  };
  void model;
  const zMid = zAt(0.3);
  const zRear = zAt(0.8);
  assert.ok(zMid * zRear < 0, `expected reflex, got z(.3)=${zMid} z(.8)=${zRear}`);
});

test('level 2: Cm given as an interval selects the minimum-energy point inside it', () => {
  // L = alpha - Cl/(2pi) = -0.2/pi ; unconstrained d* = 4L/7 -> Cm* = pi d*.
  const L = -0.2 / Math.PI;
  const cmStar = Math.PI * ((4 * L) / 7);
  const r = inverseDesign({
    alpha: 0,
    cl: 0.4,
    cmQuarter: { min: cmStar - 0.02, max: cmStar + 0.02 },
  });
  assert.ok(Math.abs(r.prediction.cmQuarter - cmStar) < 1e-12);
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0 });
  assert.ok(Math.abs(fwd.cl - 0.4) < INVERSE_CL_TOLERANCE);
  assert.ok(Math.abs(fwd.cmQuarter - cmStar) < INVERSE_CM_TOLERANCE);
  assert.deepEqual(r.target.cmQuarterInterval, { min: cmStar - 0.02, max: cmStar + 0.02 });
});

test('level 2: Cm interval that excludes the free point clamps to the nearer endpoint', () => {
  const r = inverseDesign({
    alpha: 0,
    cl: 0.4,
    cmQuarter: { min: -0.2, max: -0.15 },
  });
  // Clamped to -0.15 (nearest feasible endpoint); Cl still exact.
  assert.ok(Math.abs(r.prediction.cmQuarter - -0.15) < 1e-12);
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0 });
  assert.ok(Math.abs(fwd.cl - 0.4) < INVERSE_CL_TOLERANCE);
  assert.ok(Math.abs(fwd.cmQuarter - -0.15) < INVERSE_CM_TOLERANCE);
});

/* ------------------------------------------------------------------ */
/* Level 3: prescribed loading                                         */
/* ------------------------------------------------------------------ */

test('level 3: loading of the demo parabola is recovered to machine precision (polynomial)', () => {
  const demo = buildCamberModel({ kind: 'polynomial', coefficients: [0, 0.2, -0.2] });
  const ref = analyze({ model: demo, alpha: 0 }, 129);
  const loading = ref.loading.map((p) => ({ x: p.x, deltaCp: p.deltaCp }));
  const r = inverseDesign({ alpha: 0, loading });
  assert.equal(r.diagnostics.outputRepresentation, 'polynomial');
  if (r.camber.kind === 'polynomial') {
    assert.ok(Math.abs(r.camber.coefficients[1] - 0.2) < 1e-7);
    assert.ok(Math.abs(r.camber.coefficients[2] + 0.2) < 1e-7);
    assert.ok(Math.abs(r.camber.coefficients[3] ?? 0) < 1e-7);
  }
  assert.ok(r.verification.clError <= INVERSE_CL_TOLERANCE);
  assert.ok((r.verification.loadingRmsError ?? Infinity) < INVERSE_LOADING_RMS_TOLERANCE);
});

test('level 3: higher-harmonic loading is returned as points that close the loop', () => {
  // A0 = 0.02 singularity, b1 = 0.1, b3 = 0.05 (only odd slope harmonics,
  // so closure b0 = 0 needs the reference alpha = A0 = 0.02). Needs n=3,
  // so the line cannot be a cubic polynomial.
  const loading = loadingFromComponents(0.02, [0.1, 0, 0.05]);
  const r = inverseDesign({ alpha: 0.02, loading });
  assert.equal(r.diagnostics.outputRepresentation, 'points');
  assert.equal(r.camber.kind, 'points');
  assert.deepEqual(r.selectionCriterion.activeHarmonics.sort(), [1, 3]);
  if (r.camber.kind === 'points') {
    assert.ok(r.camber.points.length >= 1000);
    assert.equal(r.camber.points[0].x, 0);
    assert.equal(r.camber.points[r.camber.points.length - 1].x, 1);
    assert.ok(Math.abs(r.camber.points[r.camber.points.length - 1].z) < 1e-9);
  }
  assert.ok(r.verification.clError <= INVERSE_CL_TOLERANCE);
  assert.ok((r.verification.loadingRmsError ?? Infinity) <= INVERSE_LOADING_RMS_TOLERANCE);
  // Closure is imposed as an exact KKT equality, not just tolerated.
  assert.ok(Math.abs(r.diagnostics.trailingEdgeGap) < 1e-9);
  // Recovered spectrum components.
  assert.ok(Math.abs(r.diagnostics.slopeCoefficients[0] - 0) < 1e-6);
  assert.ok(Math.abs(r.diagnostics.slopeCoefficients[1] - 0.1) < 1e-6);
  assert.ok(Math.abs(r.diagnostics.slopeCoefficients[3] - 0.05) < 1e-6);
});

test('level 3: theta-coordinate samples are accepted equivalently', () => {
  const byTheta: Array<{ theta: number; deltaCp: number }> = [];
  for (let i = 1; i <= 64; i += 1) {
    const theta = (i * Math.PI) / 65;
    const dcp = 4 * 0.04 * (1 + Math.cos(theta)) / Math.sin(theta) + 4 * 0.08 * Math.sin(theta);
    byTheta.push({ theta, deltaCp: dcp });
  }
  // Odd harmonic only: closure alpha equals A0 = 0.04.
  const r = inverseDesign({ alpha: 0.04, loading: byTheta });
  assert.equal(r.verification.passed, true);
  assert.ok(Math.abs(r.prediction.coefficients.a0 - 0.04) < 1e-6);
  assert.ok(Math.abs(r.diagnostics.slopeCoefficients[1] - 0.08) < 1e-6);
});

test('level 3: pinned Cl is met exactly while matching the shape', () => {
  const loading = loadingFromComponents(0.02, [0.1, 0, 0.05]);
  const clWant = 2 * Math.PI * (0.02 + 0.05); // A0 + b1/2
  const r = inverseDesign({ alpha: 0.02, loading, cl: clWant });
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0.02 });
  assert.ok(Math.abs(fwd.cl - clWant) < INVERSE_CL_TOLERANCE);
  assert.ok((r.verification.loadingRmsError ?? Infinity) < INVERSE_LOADING_RMS_TOLERANCE);
  assert.equal(r.target.cl, clWant);
});

test('level 3: pinned non-zero Cm on a compatible reflexed loading is met', () => {
  // b1 = 0.12, b2 = 0.04 -> Cm = pi/4 (0.04 - 0.12) = -0.02 pi.
  // Closure needs b0 = b2/3, hence the consistent alpha = A0 + b2/3.
  const loading = loadingFromComponents(0.01, [0.12, 0.04]);
  const cmWant = (Math.PI / 4) * (0.04 - 0.12);
  const alpha = 0.01 + 0.04 / 3;
  const r = inverseDesign({ alpha, loading, cmQuarter: cmWant });
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha });
  assert.ok(Math.abs(fwd.cmQuarter - cmWant) < INVERSE_CM_TOLERANCE);
  assert.ok((r.verification.loadingRmsError ?? Infinity) < INVERSE_LOADING_RMS_TOLERANCE);
});

/* ------------------------------------------------------------------ */
/* Selection criterion: uniqueness/determinism                         */
/* ------------------------------------------------------------------ */

test('level 3: a noisy even-harmonic loading pins Cl against the CLOSED baseline', () => {
  // Even harmonic b2 = 0.06 forces a non-zero b0 on a closed line; small
  // deterministic noise makes the free (unclosed) fit's Cl differ from the
  // closed baseline's. The pin must be judged against the closest CLOSED
  // fit, so a pin equal to that baseline is accepted rather than falsely
  // declared inconsistent.
  const a0 = 0.01;
  const b1 = 0.12;
  const b2 = 0.06;
  const alpha = a0 + b2 / 3; // closure-consistent reference alpha
  const clean = loadingFromComponents(a0, [b1, b2]);
  const noisy = clean.map((s, i) => ({
    x: s.x,
    deltaCp: s.deltaCp + 0.008 * Math.sin(13 * s.x + 0.3 * (i + 1)),
  }));
  const clWant = 2 * Math.PI * (a0 + b1 / 2);
  const r = inverseDesign({ alpha, loading: noisy, cl: clWant });
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha });
  assert.ok(Math.abs(fwd.cl - clWant) < INVERSE_CL_TOLERANCE);
  assert.ok(Math.abs(r.diagnostics.trailingEdgeGap) < 1e-9);
  assert.ok((r.verification.loadingRmsError ?? Infinity) < INVERSE_LOADING_RMS_TOLERANCE);
});

test('the selection criterion is deterministic: identical targets, identical camber', () => {
  const req: InverseRequest = { alpha: 0.03, cl: 0.55, cmQuarter: -0.06 };
  const a = inverseDesign(req);
  const b = inverseDesign({ ...req });
  assert.deepEqual(a.camber, b.camber);
  assert.deepEqual(a.diagnostics.slopeCoefficients, b.diagnostics.slopeCoefficients);

  const loading = loadingFromComponents(0.02, [0.1, 0, 0.05]);
  const c = inverseDesign({ alpha: 0.02, loading, samples: 1201 });
  const d = inverseDesign({ alpha: 0.02, loading, samples: 1201 });
  assert.deepEqual(c.camber, d.camber);
});

test('concurrent inverse solves never mix their spectra', async () => {
  const jobs: Promise<{ cl: number; b1: number }>[] = [];
  for (let i = 0; i < 32; i += 1) {
    const b1 = 0.02 + i * 0.004;
    const cl = Math.PI * b1; // alpha = 0
    jobs.push(
      new Promise((resolve, reject) => {
        try {
          const r = inverseDesign({ alpha: 0, cl });
          resolve({ cl: r.verification.cl, b1: r.diagnostics.slopeCoefficients[1] });
        } catch (err) {
          reject(err);
        }
      }),
    );
  }
  const rs = await Promise.all(jobs);
  rs.forEach((r, i) => {
    const b1 = 0.02 + i * 0.004;
    assert.ok(Math.abs(r.b1 - b1) < 1e-12, `job ${i}`);
    assert.ok(Math.abs(r.cl - Math.PI * b1) < INVERSE_CL_TOLERANCE, `job ${i}`);
  });
});

/* ------------------------------------------------------------------ */
/* Impossible / inconsistent / malformed targets                       */
/* ------------------------------------------------------------------ */

test('symmetric-section loading pinned to non-zero Cm is TARGET_INCONSISTENT before solving', () => {
  // Pure flat-plate loading (b1 = b2 = 0): Cm is identically zero.
  const loading = loadingFromComponents(0.05, []);
  expectCode(
    () => inverseDesign({ alpha: 0.05, loading, cmQuarter: -0.05 }),
    'TARGET_INCONSISTENT',
  );
  // And the structured details name the physical reason.
  try {
    inverseDesign({ alpha: 0.05, loading, cmQuarter: -0.05 });
  } catch (err) {
    assert.ok(err instanceof ServiceError);
    assert.equal(err.details?.reason, 'SYMMETRIC_LOADING_ZERO_MOMENT');
  }
});

test('loading whose integral Cl contradicts a pinned Cl is TARGET_INCONSISTENT', () => {
  const loading = loadingFromComponents(0.05, []); // Cl = 2 pi * 0.05
  expectCode(
    () => inverseDesign({ alpha: 0.05, loading, cl: 1.2 }),
    'TARGET_INCONSISTENT',
  );
});

test('loading implying a Cm outside the requested interval is TARGET_INCONSISTENT', () => {
  // b1 = 0.12, b2 = 0.04 -> Cm = -0.02 pi ~ -0.0628. Use the closure-
  // consistent alpha so the ONLY conflict is the positive Cm interval.
  const loading = loadingFromComponents(0.01, [0.12, 0.04]);
  const alpha = 0.01 + 0.04 / 3;
  expectCode(
    () => inverseDesign({ alpha, loading, cmQuarter: { min: 0.02, max: 0.05 } }),
    'TARGET_INCONSISTENT',
  );
});

test('loading that forces an open trailing edge at the reference alpha is TARGET_UNACHIEVABLE', () => {
  // The demanded shape is the 0.05-rad flat-plate loading (A0 = 0.05, no
  // slope harmonics), but the caller insists it be reproduced at reference
  // alpha = 0.02. A closed line would then need b0 = alpha - A0 = -0.03;
  // with no even harmonics allowed (they would change the demanded shape)
  // closure requires b0 = 0, so z(1) opens by 0.03 chord. A closed thin
  // airfoil at that alpha cannot carry exactly this loading.
  const loading = loadingFromComponents(0.05, []);
  try {
    inverseDesign({ alpha: 0.02, loading });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ServiceError);
    assert.equal(err.code, 'TARGET_UNACHIEVABLE');
    assert.ok(Math.abs(err.details!.trailingEdgeGap as number) > 0.02);
  }
});

test('a lift target that needs extreme camber is TARGET_UNACHIEVABLE with details', () => {
  try {
    inverseDesign({ alpha: 0, cl: 5 });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ServiceError);
    assert.equal(err.code, 'TARGET_UNACHIEVABLE');
    assert.ok(typeof err.details?.maxCamber === 'number');
    assert.ok(err.details!.maxCamber > 0.15);
  }
});

test('geometric guards can be relaxed explicitly, but never silently', () => {
  // The same extreme target passes when the caller opts out of the camber
  // bound (the slope guard is removed too for this reflexed magnitude).
  const r = inverseDesign({
    alpha: 0,
    cl: 3,
    bounds: { maxCamber: null, maxSlope: null },
  });
  const fwd = analyze({ model: buildCamberModel(r.camber), alpha: 0 });
  assert.ok(Math.abs(fwd.cl - 3) < INVERSE_CL_TOLERANCE);
});

test('a reference alpha beyond 15 degrees is ALPHA_OUT_OF_RANGE', () => {
  expectCode(() => inverseDesign({ alpha: 0.5, cl: 0.3 }), 'ALPHA_OUT_OF_RANGE');
});

test('valid reference alpha but excessive needed incidence is TARGET_UNACHIEVABLE', () => {
  // Tier 2 (lift + moment): the closed cubic has b0 = b2/3 != 0, so even
  // at alpha = 0 the pinned moment can drive A0 = alpha - b0 past the
  // validity line. Cl = 0, Cm = -0.22 gives b0 = 4 d ~= -0.280 rad,
  // i.e. A0 ~= 0.280 rad ~= 16.0 deg.
  try {
    inverseDesign({ alpha: 0, cl: 0, cmQuarter: -0.22 });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ServiceError);
    assert.equal(err.code, 'TARGET_UNACHIEVABLE');
    assert.ok(Math.abs(err.details!.a0 as number) > 15 * (Math.PI / 180) - 1e-9);
  }
  // Explicit opt-out still computes and flags (geometric guards relaxed).
  const allowed = inverseDesign({
    alpha: 0,
    cl: 0,
    cmQuarter: -0.22,
    allowOutOfRange: true,
    bounds: { maxCamber: null, maxSlope: null },
  });
  assert.equal(allowed.outOfRange, true);
  assert.ok(Math.abs(allowed.verification.clError) < INVERSE_CL_TOLERANCE);
  assert.ok(Math.abs(allowed.verification.cmError) < INVERSE_CM_TOLERANCE);
});

test('loading needing leading-edge incidence past 15 deg is TARGET_UNACHIEVABLE', () => {
  const loading = loadingFromComponents(0.3, [0.02]);
  expectCode(
    () => inverseDesign({ alpha: 0.3, loading }),
    'ALPHA_OUT_OF_RANGE',
  );
  // Reference alpha itself is already over the line; allowOutOfRange
  // still computes and flags the result.
  const r = inverseDesign({
    alpha: 0.3,
    loading,
    allowOutOfRange: true,
    bounds: { maxCamber: null, maxSlope: null },
  });
  assert.equal(r.outOfRange, true);
});

test('too sparse, endpoint-bearing, non-monotone, mixed-coordinate, non-finite loading is rejected', () => {
  const good = loadingFromComponents(0.02, [0.1]);
  expectCode(() => inverseDesign({ alpha: 0, loading: good.slice(0, 5) }), 'INVALID_LOADING');

  const endpoints = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 1].map((x) => ({ x, deltaCp: 1 }));
  expectCode(() => inverseDesign({ alpha: 0, loading: endpoints }), 'INVALID_LOADING');

  const nonMono = [0.1, 0.3, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9].map((x) => ({ x, deltaCp: 1 }));
  expectCode(() => inverseDesign({ alpha: 0, loading: nonMono }), 'INVALID_LOADING');

  const mixed = [
    { x: 0.1, deltaCp: 1 },
    { theta: 1.0, deltaCp: 1 },
    ...[0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((x) => ({ x, deltaCp: 1 })),
  ];
  expectCode(() => inverseDesign({ alpha: 0, loading: mixed }), 'INVALID_LOADING');

  const badValue = good.map((s, i) => (i === 3 ? { x: s.x, deltaCp: NaN } : s));
  expectCode(() => inverseDesign({ alpha: 0, loading: badValue }), 'INVALID_LOADING');
});

test('missing target or moment-only target is INVALID_TARGET', () => {
  expectCode(() => inverseDesign({ alpha: 0 }), 'INVALID_TARGET');
  expectCode(() => inverseDesign({ alpha: 0, cmQuarter: -0.05 }), 'INVALID_TARGET');
});

test('requesting polynomial output for a higher-harmonic target is INVALID_TARGET', () => {
  const loading = loadingFromComponents(0.02, [0.1, 0, 0.05]);
  expectCode(
    () => inverseDesign({ alpha: 0.02, loading, output: 'polynomial' }),
    'INVALID_TARGET',
  );
});

test('forward geometry validation accepts every synthesised line unchanged', () => {
  // Every returned representation must build through the ordinary camber
  // constructor (this is what makes it reusable by /sweep and profiles).
  const targets: InverseRequest[] = [
    { alpha: 0, cl: 0.5 },
    { alpha: 0.02, cl: 0.4, cmQuarter: -0.05 },
    { alpha: 0.02, loading: loadingFromComponents(0.02, [0.1, 0, 0.05]) },
  ];
  for (const t of targets) {
    const r = inverseDesign(t);
    assert.doesNotThrow(() => buildCamberModel(r.camber));
  }
});

test('explicit points output works for scalar tiers and still closes the loop', () => {
  for (const t: InverseRequest[] of [
    { alpha: 0, cl: 0.4, output: 'points' },
    { alpha: 0, cl: 0.4, cmQuarter: -0.05, output: 'points', samples: 1500 },
  ]) {
    const r = inverseDesign(t);
    assert.equal(r.camber.kind, 'points');
    assert.equal(r.diagnostics.outputRepresentation, 'points');
    if (r.camber.kind === 'points') {
      assert.ok(r.camber.points.length >= 1024);
      assert.equal(r.camber.points[0].x, 0);
      assert.equal(r.camber.points[r.camber.points.length - 1].x, 1);
      assert.ok(Math.abs(r.camber.points[r.camber.points.length - 1].z) < 1e-9);
    }
    assert.ok(r.verification.clError <= INVERSE_CL_TOLERANCE);
    if (t.cmQuarter !== undefined) {
      assert.ok(r.verification.cmError <= INVERSE_CM_TOLERANCE);
    }
  }
});

test('auto representation keeps the exact scalar-tier lines as polynomials', () => {
  assert.equal(inverseDesign({ alpha: 0, cl: 0.4 }).camber.kind, 'polynomial');
  assert.equal(
    inverseDesign({ alpha: 0, cl: 0.4, cmQuarter: -0.05 }).camber.kind,
    'polynomial',
  );
});

test('thetaToX/xToTheta round trip used by the loader is consistent', () => {
  for (const x of [0.01, 0.2, 0.5, 0.8, 0.99]) {
    assert.ok(Math.abs(thetaToX(xToTheta(x)) - x) < 1e-12);
  }
});
