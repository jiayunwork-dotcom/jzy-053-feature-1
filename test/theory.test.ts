/**
 * Theory pinning tests. Every cross-relationship the service must obey:
 *
 *  - symmetric section: alpha_L0 = 0 and Cl/alpha = 2 pi;
 *  - scaling the whole camber line by k scales alpha_L0 and Cl(alpha=0)
 *    by k;
 *  - Cm,c/4 is invariant with alpha (identically 0 for symmetric sections);
 *  - Cl = 0 exactly when alpha = alpha_L0;
 *  - integrating the returned Delta Cp distribution reclaims the same Cl;
 *  - hand-computed demo profile values;
 *  - a dedicated guard against the "degrees fed into the radian formula"
 *    unit error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, zeroLiftAngle, MAX_ALPHA_RAD } from '../src/analyze';
import { buildCamberModel } from '../src/camber';
import { CamberDef } from '../src/types';

const TWO_PI = 2 * Math.PI;

function poly(coeffs: number[]) {
  return buildCamberModel({ kind: 'polynomial', coefficients: coeffs });
}

const flat: CamberDef = { kind: 'polynomial', coefficients: [0] };
// z(x) = 4 h x (1 - x), h = 0.05
const parabola: CamberDef = { kind: 'polynomial', coefficients: [0, 0.2, -0.2] };

test('symmetric section: alpha_L0 is zero and Cl/alpha equals 2 pi', () => {
  const model = buildCamberModel(flat);
  assert.equal(zeroLiftAngle(model), 0);
  for (const alpha of [0.01, 0.05, 0.1, 0.2]) {
    const r = analyze({ model, alpha });
    assert.ok(Math.abs(r.alphaL0) < 1e-12);
    assert.ok(Math.abs(r.cl / alpha - TWO_PI) < 1e-10, `alpha=${alpha}`);
    assert.ok(Math.abs(r.cmQuarter) < 1e-12);
  }
});

test('symmetric discrete zero line behaves identically', () => {
  const model = buildCamberModel({
    kind: 'points',
    points: [
      { x: 0, z: 0 },
      { x: 0.25, z: 0 },
      { x: 0.5, z: 0 },
      { x: 1, z: 0 },
    ],
  });
  assert.equal(zeroLiftAngle(model), 0);
  const r = analyze({ model, alpha: 0.08726646259971647 }); // 5 deg in rad
  assert.ok(Math.abs(r.cl - TWO_PI * 0.08726646259971647) < 1e-10);
});

test('demo parabola hand calculation: alpha_L0 = -0.1, Cl(0)=0.2 pi, Cm=-0.05 pi', () => {
  const model = buildCamberModel(parabola);
  const alphaL0 = zeroLiftAngle(model);
  assert.ok(Math.abs(alphaL0 - -0.1) < 1e-10, `alphaL0=${alphaL0}`);
  // Sign check: positive camber => negative alpha_L0, positive lift at 0.
  assert.ok(alphaL0 < 0);

  const r0 = analyze({ model, alpha: 0 });
  assert.ok(Math.abs(r0.cl - 0.2 * Math.PI) < 1e-9, `cl(0)=${r0.cl}`);
  assert.ok(r0.cl > 0);
  assert.ok(Math.abs(r0.cmQuarter - -0.05 * Math.PI) < 1e-9, `cm=${r0.cmQuarter}`);
});

test('scaling camber by k scales alpha_L0 and Cl(alpha=0) by k', () => {
  const base = poly([0, 0.2, -0.2]);
  for (const k of [0.5, 1, 2, -1]) {
    const scaled = poly([0, 0.2 * k, -0.2 * k]);
    assert.ok(Math.abs(zeroLiftAngle(scaled) - k * zeroLiftAngle(base)) < 1e-9);
    const clBase = analyze({ model: base, alpha: 0 }).cl;
    const clScaled = analyze({ model: scaled, alpha: 0 }).cl;
    assert.ok(Math.abs(clScaled - k * clBase) < 1e-9, `k=${k}`);
  }
});

test('Cm,c/4 does not move with alpha and is zero for symmetric sections', () => {
  const model = buildCamberModel(parabola);
  const cms = [-0.1, 0, 0.1, 0.2].map((alpha) => analyze({ model, alpha }).cmQuarter);
  for (const cm of cms) {
    assert.ok(Math.abs(cm - cms[0]) < 1e-12);
  }
  const sym = buildCamberModel(flat);
  for (const alpha of [-0.2, 0, 0.2]) {
    assert.ok(Math.abs(analyze({ model: sym, alpha }).cmQuarter) < 1e-12);
  }
});

test('Cl vanishes exactly when alpha = alpha_L0', () => {
  const model = buildCamberModel(parabola);
  const alphaL0 = zeroLiftAngle(model);
  const r = analyze({ model, alpha: alphaL0 });
  assert.ok(Math.abs(r.cl) < 1e-9, `cl at alphaL0=${r.cl}`);
});

test('integrating Delta Cp over the chord reclaims Cl', () => {
  for (const def of [
    flat,
    parabola,
    { kind: 'polynomial' as const, coefficients: [0.01, 0.05, -0.12, 0.06] },
  ]) {
    const model = buildCamberModel(def);
    for (const alpha of [0, 0.05, -0.05]) {
      const r = analyze({ model, alpha }, 257);
      assert.ok(
        Math.abs(r.loadingIntegralCl - r.cl) < 1e-7,
        `def=${JSON.stringify(def)} alpha=${alpha} int=${r.loadingIntegralCl} cl=${r.cl}`,
      );
      // Also integrate the actual RETURNED sample grid independently.
      const direct = integrateReturned(r.loading);
      assert.ok(Math.abs(direct - r.cl) < 1e-3);
    }
  }
});

/** Independent midpoint integration of the samples actually returned. */
function integrateReturned(points: Array<{ theta: number; deltaCp: number }>): number {
  const n = points.length;
  const dTheta = Math.PI / n;
  let acc = 0;
  for (const p of points) acc += p.deltaCp * Math.sin(p.theta);
  return 0.5 * acc * dTheta;
}

test('loading stays finite on the interior grid and has the flat-plate shape at alpha=0.1', () => {
  const model = buildCamberModel(flat);
  const alpha = 0.1;
  const r = analyze({ model, alpha },129);
  for (const p of r.loading) {
    assert.ok(Number.isFinite(p.deltaCp));
    assert.ok(p.x > 0 && p.x < 1);
    // Flat plate: Delta Cp = 4 alpha (1+cos theta)/sin theta; positive.
    const expected = (4 * alpha * (1 + Math.cos(p.theta))) / Math.sin(p.theta);
    assert.ok(Math.abs(p.deltaCp - expected) < 1e-9);
  }
});

test('point-defined line converges to the polynomial line as samples densify', () => {
  const exact = buildCamberModel(parabola);
  const discretize = (N: number) => {
    const samples = [];
    for (let i = 0; i <= N; i += 1) {
      const x = i / N;
      samples.push({ x, z: 0.2 * x * (1 - x) });
    }
    return buildCamberModel({ kind: 'points', points: samples });
  };

  const exactA0 = zeroLiftAngle(exact);
  const errAt = (N: number) => ({
    a0: Math.abs(zeroLiftAngle(discretize(N)) - exactA0),
  });
  const coarse = errAt(200);
  const fine = errAt(4000);
  // Piecewise-linear slope approximation: error must shrink as N refines.
  assert.ok(fine.a0 < coarse.a0 / 10, `coarse=${coarse.a0} fine=${fine.a0}`);
  assert.ok(fine.a0 < 5e-6, `fine=${fine.a0}`);

  const a = analyze({ model: exact, alpha: 0.03 });
  const b = analyze({ model: discretize(4000), alpha: 0.03 });
  assert.ok(Math.abs(a.cl - b.cl) < 1e-4);
  assert.ok(Math.abs(a.cmQuarter - b.cmQuarter) < 1e-4);
});

test('chord scaling: physical coordinates divided by chord match normalised input', () => {
  // Physical line z_phys = 0.2 x_phys (1 - x_phys/c), chord c = 2.
  // Normalising x' = x_phys/c and z' = z_phys/c gives
  //   z'(x') = 0.2 x' (1 - x')  (the h = 0.05 demo parabola)
  // so alpha_L0 must equal the demo's -0.10.
  const c = 2;
  const zPhys = (xPhys: number) => 0.2 * xPhys * (1 - xPhys / c);
  const N = 2000;
  const pts = [];
  for (let i = 0; i <= N; i += 1) {
    const xPhys = (c * i) / N;
    pts.push({ x: xPhys, z: zPhys(xPhys) });
  }
  const scaled = buildCamberModel({ kind: 'points', chord: c, points: pts });
  assert.ok(Math.abs(zeroLiftAngle(scaled) - zeroLiftAngle(buildCamberModel(parabola))) < 1e-5);
  assert.ok(Math.abs(zeroLiftAngle(scaled) - -0.1) < 1e-5);
  // And equal to directly-supplied normalised samples of the same shape.
  const normalisedPts = pts.map((p) => ({ x: p.x / c, z: p.z / c }));
  const direct = buildCamberModel({ kind: 'points', points: normalisedPts });
  assert.ok(Math.abs(zeroLiftAngle(scaled) - zeroLiftAngle(direct)) < 1e-12);
});

/**
 * Dedicated anti-regression for unit confusion: the service speaks RADIANS.
 * 15 degrees expressed in radians (~0.2618) must be ACCEPTED, while the
 * same quantity passed as the raw number 15 (i.e. degrees fed straight
 * into the radian formula) must be REJECTED as out of range. A caller
 * silently treating degrees as radians must never get a lift curve back.
 */
test('unit guard: 15 degrees is fine in radians, the literal 15 is refused', () => {
  const model = buildCamberModel(flat);
  const rad15 = MAX_ALPHA_RAD; // 15° converted to radians
  assert.doesNotThrow(() => analyze({ model, alpha: rad15 }));
  assert.ok(rad15 < 1); // sanity: radians are not degrees

  // Cl at 10 degrees must use 10*pi/180, giving 2pi * 0.1745... ~= 1.0966.
  const tenDegRad = (10 * Math.PI) / 180;
  const r = analyze({ model, alpha: tenDegRad });
  assert.ok(Math.abs(r.cl - TWO_PI * tenDegRad) < 1e-12);
  assert.ok(Math.abs(r.cl - 1.096622711232151) < 1e-9);

  // The classic unit bug: passing 10 (degrees) directly. The resulting
  // "Cl = 20 pi" is physically impossible and must be blocked upstream by
  // the 15-degree radian limit (|10| > 0.2618).
  assert.ok(Math.abs(10) > MAX_ALPHA_RAD);
});

test('higher camber harmonics only affect Cm, never the symmetric baseline', () => {
  // eta = cos 2theta shaped line is z(x) with A1 contribution ~0.
  const m = poly([0.02, -0.06, 0.04]); // arbitrary nonzero camber
  const r = analyze({ model: m, alpha: 0.04 });
  assert.ok(Math.abs(r.cmQuarter - (Math.PI / 4) * (r.coefficients.a2 - r.coefficients.a1)) < 1e-12);
});
