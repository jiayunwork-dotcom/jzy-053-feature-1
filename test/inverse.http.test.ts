/**
 * End-to-end HTTP tests for POST /inverse, run against the real Express
 * stack on an ephemeral port with a temp profile document.
 *
 * Pins the full loop over the wire:
 *
 *   target -> POST /inverse -> camber -> POST /analyze -> target back
 *
 * plus registration-as-profile reuse by /analyze and /sweep, structured
 * errors for impossible/inconsistent/malformed targets, and isolation of
 * concurrent inverse requests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import { AddressInfo } from 'net';
import { createApp } from '../src/app';
import { ProfileStore } from '../src/profileStore';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taps-inv-http-'));
  return path.join(dir, 'profiles.json');
}

interface Harness {
  base: string;
  server: Server;
  store: ProfileStore;
}

async function start(): Promise<Harness> {
  const store = await ProfileStore.open({ filePath: await tempFile() });
  const app = await createApp(store);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server, store };
}

async function post(h: Harness, route: string, body: unknown) {
  const res = await fetch(`${h.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('inverse lift: camber returned reproduces the target when fed back to /analyze', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const { status, body } = await post(h, '/inverse', { alpha: 0, cl: 0.6 });
  assert.equal(status, 200);
  assert.equal(body.target.kind, 'lift');
  assert.ok(body.camber.kind === 'polynomial');
  assert.equal(body.selectionCriterion.id, 'minimum-glauert-order');
  assert.ok(body.verification.passed === true);
  assert.ok(body.verification.clError <= body.verification.tolerance.cl);

  // The hard requirement, end to end: feed the returned camber straight
  // back into the existing single-section endpoint.
  const fwd = await post(h, '/analyze', { camber: body.camber, alpha: 0 });
  assert.equal(fwd.status, 200);
  assert.ok(Math.abs(fwd.body.cl - 0.6) < body.verification.tolerance.cl);
});

test('inverse lift+moment: both scalars come back through /analyze', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const inv = await post(h, '/inverse', { alpha: 0, cl: 0.4, cmQuarter: -0.05 });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.target.kind, 'lift-moment');
  assert.ok(inv.body.verification.cmError <= inv.body.verification.tolerance.cm);

  const fwd = await post(h, '/analyze', { camber: inv.body.camber, alpha: 0 });
  assert.ok(Math.abs(fwd.body.cl - 0.4) < 1e-6);
  assert.ok(Math.abs(fwd.body.cmQuarter - -0.05) < 1e-5);
});

test('inverse loading returns points and the shape closes the loop', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  // Higher-harmonic loading (b1 and b3) at the closure-consistent alpha.
  const loading = [];
  for (let i = 1; i <= 100; i += 1) {
    const x = i / 101;
    const theta = Math.acos(1 - 2 * x);
    const deltaCp =
      (4 * 0.02 * (1 + Math.cos(theta))) / Math.sin(theta) +
      4 * (0.1 * Math.sin(theta) + 0.05 * Math.sin(3 * theta));
    loading.push({ x, deltaCp });
  }
  const inv = await post(h, '/inverse', { alpha: 0.02, loading });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.equal(inv.body.camber.kind, 'points');
  assert.ok(inv.body.verification.loadingRmsError <= inv.body.verification.tolerance.loadingRms);

  // The returned point line is ordinary camber: /analyze accepts it and
  // reclaims the same lift.
  const fwd = await post(h, '/analyze', { camber: inv.body.camber, alpha: 0.02 });
  assert.equal(fwd.status, 200);
  assert.ok(Math.abs(fwd.body.cl - inv.body.prediction.cl) < 1e-5);
});

test('inverse can register a named profile, reusable by /analyze and /sweep', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const inv = await post(h, '/inverse', {
    alpha: 0,
    cl: 0.5,
    register: { id: 'cruise-cl50', name: 'Cruise design' },
  });
  assert.equal(inv.status, 201);
  assert.deepEqual(inv.body.profile, { id: 'cruise-cl50' });

  // Listed among profiles.
  const list = await (await fetch(`${h.base}/profiles`)).json();
  assert.ok(list.profiles.some((p: { id: string }) => p.id === 'cruise-cl50'));

  // Reused by reference in /analyze.
  const fwd = await post(h, '/analyze', { profile: 'cruise-cl50', alpha: 0 });
  assert.equal(fwd.status, 200);
  assert.ok(Math.abs(fwd.body.cl - 0.5) < 1e-6);

  // And by /sweep (the shape is shared infrastructure).
  const sweep = await post(h, '/sweep', {
    profile: 'cruise-cl50',
    alphaStart: -0.05,
    alphaEnd: 0.05,
    steps: 4,
  });
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.count, 5);
  for (let i = 1; i < sweep.body.points.length; i += 1) {
    assert.ok(sweep.body.points[i].cl > sweep.body.points[i - 1].cl);
  }
});

test('inverse symmetric-loading + non-zero moment is a structured 422 before solving', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const loading = [];
  for (let i = 1; i <= 64; i += 1) {
    const x = i / 65;
    const theta = Math.acos(1 - 2 * x);
    loading.push({ x, deltaCp: (4 * 0.05 * (1 + Math.cos(theta))) / Math.sin(theta) });
  }
  const r = await post(h, '/inverse', { alpha: 0.05, loading, cmQuarter: -0.05 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'TARGET_INCONSISTENT');
  assert.equal(r.body.error.details.reason, 'SYMMETRIC_LOADING_ZERO_MOMENT');
});

test('inverse impossible lift (extreme camber) is a structured 422 with details', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const r = await post(h, '/inverse', { alpha: 0, cl: 5 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'TARGET_UNACHIEVABLE');
  assert.ok(typeof r.body.error.details.maxCamber === 'number');
});

test('inverse reference alpha over 15 degrees is ALPHA_OUT_OF_RANGE', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const r = await post(h, '/inverse', { alpha: 0.5, cl: 0.3 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'ALPHA_OUT_OF_RANGE');
});

test('inverse malformed payloads are INVALID_REQUEST / INVALID_LOADING', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  // No target at all.
  assert.equal((await post(h, '/inverse', { alpha: 0 })).body.error.code, 'INVALID_TARGET');
  // Non-finite cl.
  assert.equal((await post(h, '/inverse', { alpha: 0, cl: 'x' })).body.error.code, 'INVALID_REQUEST');
  // Unknown field (strict schema).
  assert.equal(
    (await post(h, '/inverse', { alpha: 0, cl: 0.3, bogus: 1 })).body.error.code,
    'INVALID_REQUEST',
  );
  // Sparse loading is structurally fine but mathematically inadmissible.
  assert.equal(
    (await post(h, '/inverse', { alpha: 0, loading: [{ x: 0.5, deltaCp: 1 }] })).body.error.code,
    'INVALID_LOADING',
  );
});

test('concurrent inverse requests never mix camber lines', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const jobs = [];
  for (let i = 0; i < 24; i += 1) {
    const b1 = 0.04 + i * 0.005;
    jobs.push(post(h, '/inverse', { alpha: 0, cl: Math.PI * b1 }));
  }
  const responses = await Promise.all(jobs);
  responses.forEach((r, i) => {
    assert.equal(r.status, 200, `job ${i}`);
    const b1 = 0.04 + i * 0.005;
    // Lift-only parabola: coefficients [0, b1, -b1].
    assert.ok(Math.abs(r.body.camber.coefficients[1] - b1) < 1e-12, `job ${i}`);
    assert.ok(Math.abs(r.body.verification.cl - Math.PI * b1) < 1e-6, `job ${i}`);
  });
});

test('inverse profile registration duplicates return PROFILE_EXISTS without a half-created line', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const first = await post(h, '/inverse', { alpha: 0, cl: 0.3, register: { id: 'dup' } });
  assert.equal(first.status, 201);
  const second = await post(h, '/inverse', { alpha: 0, cl: 0.4, register: { id: 'dup' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'PROFILE_EXISTS');
});
