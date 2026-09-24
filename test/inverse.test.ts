/**
 * Inverse-design module tests.
 *
 * These pin the hard contract of the new capability:
 *
 *  - CLOSED LOOP: every inverse-designed camber, fed back through the exact
 *    forward evaluator, reclaims the requested Cl (and pinned Cm) inside the
 *    stated tolerances;
 *  - the answer is UNIQUE and explainable: the minimum-slope-energy
 *    criterion and its constraints are returned, and the same target always
 *    yields the identical camber;
 *  - all three target tiers work (lift, lift+moment, loading shape);
 *  - impossible/contradictory targets are rejected BEFORE solving with the
 *    right structured error (symmetric + nonzero Cm, out-of-envelope lift,
 *    loading samples too few / non-monotonic / at endpoints);
 *  - concurrent inverse requests never share state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { designForScalars, designForLoading, DEFAULT_TOLERANCE } from '../src/inverse';
import { buildCamberModel } from '../src/camber';
import { analyze } from '../src/analyze';
import { ServiceError } from '../src/errors';
import type { CamberDef } from '../src/types';

function expectCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (err: unknown) => err instanceof ServiceError && err.code === code,
    `expected ServiceError ${code}`,
  );
}

/** Independent forward re-evaluation (the verification the service promises). */
function forward(camber: CamberDef, alpha: number) {
  return analyze({ model: buildCamberModel(camber), alpha }, 257);
}

test('lift tier: synthesised camber reclaims the requested Cl in tolerance', () => {
  const alpha = 0;
  const cl = 0.2 * Math.PI;
  const r = designForScalars({ alpha, cl });
  assert.equal(r.verification.passed, true);
  assert.ok(r.verification.clError <= DEFAULT_TOLERANCE.cl);
  assert.ok(Math.abs(r.verification.clError) < 1e-3);
  // Independently re-evaluate, not trusting the module's own verification.
  const f = forward(r.camber, alpha);
  assert.ok(Math.abs(f.cl - cl) < 1e-3, `cl=${f.cl}`);
  // Returned geometry is one of the two existing representations.
  assert.equal(r.camber.kind, 'points');
  assert.ok(r.camber.points.length >= 100);
  // Closed trailing edge and leading edge.
  assert.ok(Math.abs(r.camber.points[0].z) < 1e-12);
  assert.ok(Math.abs(r.camber.points[r.camber.points.length - 1].z) < 1e-12);
});

test('lift tier at a nonzero reference angle of attack', () => {
  const alpha = 0.05;
  const cl = 0.4;
  const r = designForScalars({ alpha, cl });
  assert.equal(r.verification.passed, true);
  const f = forward(r.camber, alpha);
  assert.ok(Math.abs(f.cl - cl) < 1e-3);
});

test('negative lift targets work (negative camber)', () => {
  const r = designForScalars({ alpha: 0, cl: -0.5 });
  assert.equal(r.verification.passed, true);
  const f = forward(r.camber, 0);
  assert.ok(Math.abs(f.cl - -0.5) < 1e-3);
  // The camber must deflect downward somewhere.
  const minZ = Math.min(...r.camber.points.map((p) => p.z));
  assert.ok(minZ < 0);
});

test('lift+moment tier pins both Cl and Cm,c/4', () => {
  const alpha = 0.03;
  const cl = 0.5;
  const cm = -0.05;
  const r = designForScalars({ alpha, cl, cmQuarter: cm });
  assert.equal(r.verification.passed, true);
  const f = forward(r.camber, alpha);
  assert.ok(Math.abs(f.cl - cl) < 2e-3);
  assert.ok(Math.abs(f.cmQuarter - cm) < 5e-4);
  // The moment constraint is listed in the criterion.
  assert.ok(r.criterion.constraints.includes('cm_quarter_target'));
});

test('Cm is independent of angle of attack for the inverse-designed line', () => {
  const cm = -0.06;
  const r = designForScalars({ alpha: 0.02, cl: 0.35, cmQuarter: cm });
  const model = buildCamberModel(r.camber);
  const a = analyze({ model, alpha: -0.1 }).cmQuarter;
  const b = analyze({ model, alpha: 0.12 }).cmQuarter;
  assert.ok(Math.abs(a - cm) < 5e-4);
  assert.ok(Math.abs(b - cm) < 5e-4);
});

test('uniqueness: identical target deterministically yields identical camber', () => {
  const target = { alpha: 0.04, cl: 0.55, cmQuarter: -0.04 };
  const r1 = designForScalars(target);
  const r2 = designForScalars({ ...target });
  assert.deepEqual(r1.camber, r2.camber);
  // The regularisation criterion is returned with the answer.
  assert.equal(r1.criterion.name, 'minimum_slope_energy');
  assert.equal(r1.criterion.closedTrailingEdge, true);
  assert.ok(r1.criterion.description.length > 20);
  assert.ok(r1.criterion.constraints.includes('cl_target'));
  assert.ok(r1.criterion.constraints.includes('closed_trailing_edge'));
});

test('minimum-energy pick is the lowest-order admissible line: no higher harmonics', () => {
  // For a lift+closure problem the minimiser must live exactly in the span of
  // the two representers {1, cos, sin} — i.e. no cos2+ energy. Verify its m2
  // is produced purely by the sin closure term and adding any orthogonal
  // cos3 perturbation keeps the constraints but RAISES slope energy.
  const r = designForScalars({ alpha: 0, cl: 0.3 });
  const model = buildCamberModel(r.camber);
  const energy = (m: typeof model) => {
    // (1/pi) int eta^2 dtheta approximated on the piecewise-constant line.
    const pts = m.def.kind === 'points' ? m.def.points : [];
    let e = 0;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const s = (pts[i + 1].z - pts[i].z) / (pts[i + 1].x - pts[i].x);
      const tA = Math.acos(1 - 2 * pts[i].x);
      const tB = Math.acos(1 - 2 * pts[i + 1].x);
      e += s * s * (tB - tA);
    }
    return e / Math.PI;
  };
  const base = energy(model);
  // Perturb the SLOPE by eps*cos(3 theta). It is orthogonal to BOTH the lift
  // weight (1 - cos theta) and the closure weight sin theta
  //   int cos3 (1-cos) = 0,  int cos3 sin = 0  (n=3 is odd),
  // so it preserves Cl and z(1)=0 exactly while strictly ADDING slope
  // energy. The minimum-energy solution must therefore beat it.
  const eps = 0.02;
  // z(theta) = (1/2) int_0^theta eta(u) sin u du. For eta = eps cos(3u):
  //   G(t) = int cos(3u) sin u du = 1/2(-cos4t/4 + cos2t/2), G(0)=1/8,
  //   and G(pi) = G(0) so the trailing edge stays closed.
  const G = (t: number) => 0.5 * (-Math.cos(4 * t) / 4 + Math.cos(2 * t) / 2);
  const perturbed: CamberDef = {
    kind: 'points',
    points: r.camber.points.map((p) => {
      const theta = Math.acos(1 - 2 * p.x);
      return { x: p.x, z: p.z + (eps / 2) * (G(theta) - G(0)) };
    }),
  };
  perturbed.points[perturbed.points.length - 1].z = 0;
  const pm = buildCamberModel(perturbed);
  assert.ok(energy(pm) > base, `perturbed ${energy(pm)} <= base ${base}`);
  // And the perturbation genuinely preserves the lift target.
  const pf = analyze({ model: pm, alpha: 0 });
  const bf = analyze({ model, alpha: 0 });
  assert.ok(Math.abs(pf.cl - bf.cl) < 1e-5, `dcl=${Math.abs(pf.cl - bf.cl)}`);
});

test('loading tier: reconstructs the requested chordwise loading shape', () => {
  // Reference CLOSED camber; generate the target trajectory from forward eval.
  const ref: CamberDef = {
    kind: 'polynomial',
    coefficients: [0, 0.15, -0.225, 0.075],
  };
  const alpha = 0.04;
  const refModel = buildCamberModel(ref);
  const target = analyze({ model: refModel, alpha }, 65).loading.map((p) => ({
    x: p.x,
    deltaCp: p.deltaCp,
  }));
  const r = designForLoading({ alpha, loading: target });
  assert.equal(r.verification.passed, true);
  assert.ok(r.criterion.constraints.includes('loading_least_squares'));

  // Compare the reproduced trajectory point-by-point.
  const back = analyze({ model: buildCamberModel(r.camber), alpha }, 65).loading;
  let sumSq = 0;
  for (let i = 0; i < target.length; i += 1) {
    const d = back[i].deltaCp - target[i].deltaCp;
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / target.length);
  assert.ok(rms < 0.02, `rms=${rms}`);
});

test('loading tier: sparse but sufficient samples are accepted', () => {
  const samples = Array.from({ length: 12 }, (_, i) => {
    const x = (i + 0.5) / 12;
    const theta = Math.acos(1 - 2 * x);
    // Flat-plate-shaped loading at alpha=0.05.
    return { x, deltaCp: (4 * 0.05 * (1 + Math.cos(theta))) / Math.sin(theta) };
  });
  const r = designForLoading({ alpha: 0.05, loading: samples });
  assert.equal(r.verification.passed, true);
  const f = forward(r.camber, 0.05);
  // Flat plate target integrates to 2 pi alpha.
  assert.ok(Math.abs(f.cl - 2 * Math.PI * 0.05) < 5e-3);
});

test('symmetric + nonzero moment is rejected up front as inconsistent', () => {
  expectCode(
    () => designForScalars({ alpha: 0.05, cl: 0.3, cmQuarter: -0.05, symmetric: true }),
    'TARGET_INCONSISTENT',
  );
});

test('symmetric request meeting Cl=2 pi alpha returns the flat line', () => {
  const alpha = 0.05;
  const r = designForScalars({ alpha, cl: 2 * Math.PI * alpha, symmetric: true });
  assert.equal(r.verification.passed, true);
  assert.ok(r.camber.points.every((p) => p.z === 0));
  assert.equal(forward(r.camber, alpha).cmQuarter, 0);
});

test('symmetric request asking for lift beyond 2 pi alpha is unrealizable', () => {
  expectCode(() => designForScalars({ alpha: 0.05, cl: 0.8, symmetric: true }), 'TARGET_UNREALIZABLE');
});

test('excessive lift that requires wild camber is TARGET_UNREALIZABLE', () => {
  expectCode(() => designForScalars({ alpha: 0, cl: 3 }), 'TARGET_UNREALIZABLE');
});

test('reference angle beyond 15 degrees is TARGET_UNREALIZABLE', () => {
  expectCode(() => designForScalars({ alpha: 0.3, cl: 0.2 }), 'TARGET_UNREALIZABLE');
});

test('loading: too few samples is LOADING_TOO_FEW_SAMPLES before solving', () => {
  expectCode(
    () => designForLoading({ alpha: 0, loading: [{ x: 0.2, deltaCp: 1 }, { x: 0.5, deltaCp: 1 }] }),
    'LOADING_TOO_FEW_SAMPLES',
  );
});

test('loading: non-monotonic x is LOADING_NOT_MONOTONIC', () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({
    x: 0.05 + i * 0.08,
    deltaCp: 1,
  }));
  samples[5].x = samples[2].x; // force a violation
  expectCode(() => designForLoading({ alpha: 0, loading: samples }), 'LOADING_NOT_MONOTONIC');
});

test('loading: endpoint or out-of-chord x is LOADING_MALFORMED', () => {
  const at0 = Array.from({ length: 8 }, (_, i) => ({ x: i / 7, deltaCp: 1 }));
  expectCode(() => designForLoading({ alpha: 0, loading: at0 }), 'LOADING_MALFORMED');
  const bad = Array.from({ length: 8 }, (_, i) => ({ x: 0.1 + i * 0.1, deltaCp: 1 }));
  bad[3] = { x: 0.4, deltaCp: NaN };
  expectCode(() => designForLoading({ alpha: 0, loading: bad }), 'LOADING_MALFORMED');
});

test('custom tolerance is respected and reported', () => {
  const tol = { cl: 1e-4, cmQuarter: 1e-5 };
  const r = designForScalars({ alpha: 0.02, cl: 0.3, cmQuarter: -0.03, tolerance: tol });
  assert.deepEqual(r.verification.tolerance, tol);
  assert.ok(r.verification.clError <= tol.cl);
  assert.ok(r.verification.cmQuarterError <= tol.cmQuarter);
});

test('a tolerance tighter than the synthesis resolution is a structured failure', () => {
  expectCode(
    () =>
      designForScalars({
        alpha: 0.03,
        cl: 0.5,
        cmQuarter: -0.05,
        tolerance: { cl: 1e-12, cmQuarter: 1e-12 },
      }),
    'INVERSE_TOLERANCE_NOT_MET',
  );
});

test('concurrent inverse designs never mix results', async () => {
  const jobs: Promise<{ cl: number; cm?: number; camber: CamberDef }>[] = [];
  for (let i = 0; i < 32; i += 1) {
    const cl = 0.2 + (i % 5) * 0.1;
    const cm = i % 2 === 0 ? -0.03 - (i % 3) * 0.01 : undefined;
    jobs.push(
      Promise.resolve().then(() => {
        const r = designForScalars({ alpha: 0.02, cl, ...(cm !== undefined ? { cmQuarter: cm } : {}) });
        return { cl, cm, camber: r.camber };
      }),
    );
  }
  const results = await Promise.all(jobs);
  // Distinct targets must give distinct, individually-correct cambers.
  const seen = new Set<string>();
  for (const res of results) {
    const f = forward(res.camber, 0.02);
    assert.ok(Math.abs(f.cl - res.cl) < 2e-3);
    if (res.cm !== undefined) assert.ok(Math.abs(f.cmQuarter - res.cm) < 5e-4);
    seen.add(JSON.stringify(res.camber));
  }
  assert.ok(seen.size > 5, 'results collapsed onto a shared camber');
});
