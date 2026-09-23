/**
 * Input validation tests: every required edge case must be caught BEFORE
 * any math runs, with a typed structured error — never an uncaught
 * exception or an empty response.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCamberModel } from '../src/camber';
import { checkAlpha, analyze, MAX_ALPHA_RAD } from '../src/analyze';
import { ServiceError } from '../src/errors';

function expectCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (err: unknown) => err instanceof ServiceError && err.code === code,
    `expected ServiceError code ${code}`,
  );
}

test('non-monotonic x is rejected with NON_MONOTONIC_X', () => {
  expectCode(
    () =>
      buildCamberModel({
        kind: 'points',
        points: [
          { x: 0, z: 0 },
          { x: 0.5, z: 0.02 },
          { x: 0.4, z: 0.01 },
          { x: 1, z: 0 },
        ],
      }),
    'NON_MONOTONIC_X',
  );
  // Equal x also breaks STRICT increase.
  expectCode(
    () =>
      buildCamberModel({
        kind: 'points',
        points: [
          { x: 0, z: 0 },
          { x: 0.5, z: 0.02 },
          { x: 0.5, z: 0.03 },
          { x: 1, z: 0 },
        ],
      }),
    'NON_MONOTONIC_X',
  );
});

test('too few discrete points is rejected with TOO_FEW_POINTS', () => {
  expectCode(
    () => buildCamberModel({ kind: 'points', points: [{ x: 0, z: 0 }] }),
    'TOO_FEW_POINTS',
  );
  expectCode(() => buildCamberModel({ kind: 'points', points: [] }), 'TOO_FEW_POINTS');
});

test('unnormalised chord with no scaling info is rejected', () => {
  expectCode(
    () =>
      buildCamberModel({
        kind: 'points',
        points: [
          { x: 0, z: 0 },
          { x: 1.5, z: 0.05 },
          { x: 3, z: 0 },
        ],
      }),
    'CHORD_NOT_NORMALIZED',
  );
});

test('providing chord rescales and accepts the same data', () => {
  const model = buildCamberModel({
    kind: 'points',
    chord: 3,
    points: [
      { x: 0, z: 0 },
      { x: 1.5, z: 0.05 },
      { x: 3, z: 0 },
    ],
  });
  assert.ok(model.def.kind === 'points');
  assert.ok(Math.abs(model.def.points[1].x - 0.5) < 1e-12);
});

test('invalid chord values are rejected with INVALID_CHORD', () => {
  for (const chord of [0, -1, NaN, Infinity]) {
    expectCode(
      () => buildCamberModel({ kind: 'points', chord: chord as number, points: [
        { x: 0, z: 0 }, { x: 1, z: 0 },
      ] }),
      'INVALID_CHORD',
    );
  }
});

test('malformed polynomial is rejected with INVALID_POLYNOMIAL', () => {
  expectCode(
    () => buildCamberModel({ kind: 'polynomial', coefficients: [] }),
    'INVALID_POLYNOMIAL',
  );
  expectCode(
    () => buildCamberModel({ kind: 'polynomial', coefficients: [1, NaN] }),
    'INVALID_POLYNOMIAL',
  );
});

test('non-finite alpha is INVALID_ALPHA', () => {
  const model = buildCamberModel({ kind: 'polynomial', coefficients: [0] });
  for (const bad of [NaN, Infinity, '0.1', null, undefined]) {
    expectCode(() => checkAlpha(bad as never), 'INVALID_ALPHA');
  }
  assert.throws(() => analyze({ model, alpha: NaN }), (e: unknown) =>
    e instanceof ServiceError ? e.code === 'INVALID_ALPHA' : false,
  );
});

test('alpha beyond 15 degrees is ALPHA_OUT_OF_RANGE', () => {
  const over = MAX_ALPHA_RAD + 0.01;
  expectCode(() => checkAlpha(over), 'ALPHA_OUT_OF_RANGE');
  expectCode(() => checkAlpha(-over), 'ALPHA_OUT_OF_RANGE');
  // Exactly at the limit is still accepted.
  assert.doesNotThrow(() => checkAlpha(MAX_ALPHA_RAD));
});

test('allowOutOfRange computes and flags instead of throwing', () => {
  const r = checkAlpha(MAX_ALPHA_RAD + 0.05, true);
  assert.equal(r.outOfRange, true);
  const r2 = checkAlpha(0.1, true);
  assert.equal(r2.outOfRange, false);
});

test('garbage sample entries and wrong kind are structured errors', () => {
  expectCode(
    () =>
      buildCamberModel({
        kind: 'points',
        points: [
          { x: 0, z: 'zero' },
          { x: 1, z: 0 },
        ] as never,
      }),
    'INVALID_REQUEST',
  );
  expectCode(() => buildCamberModel({ kind: 'bezier' } as never), 'INVALID_REQUEST');
});
