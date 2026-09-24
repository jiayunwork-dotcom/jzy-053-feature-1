/**
 * End-to-end HTTP tests against the real Express stack over an ephemeral
 * port and a temp profile document.
 *
 * Covers: single analysis, alpha sweep, batch isolation (one bad geometry
 * never affects the others), stored-profile reuse, structured error
 * envelopes, malformed JSON, and request isolation under concurrency.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taps-http-'));
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

interface CallInit {
  method?: string;
  body?: unknown;
  raw?: string;
}

async function call(
  h: Harness,
  route: string,
  init: CallInit = {},
): Promise<{ status: number; body: any }> {
  const method = init.method ?? 'POST';
  const hasBody = init.raw !== undefined || init.body !== undefined;
  const res = await fetch(`${h.base}${route}`, {
    method,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody
      ? init.raw ?? JSON.stringify(init.body)
      : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('health endpoint reports ok', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const res = await fetch(`${h.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('POST /analyze: symmetric section returns Cl = 2 pi alpha', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/analyze', {
    body: { camber: { kind: 'polynomial', coefficients: [0] }, alpha: 0.1 },
  });
  assert.equal(status, 200);
  assert.ok(Math.abs(body.cl - 0.2 * Math.PI) < 1e-9);
  assert.ok(Math.abs(body.alphaL0) < 1e-12);
  assert.ok(Array.isArray(body.loading));
  assert.ok(Math.abs(body.loadingIntegralCl - body.cl) < 1e-7);
});

test('POST /analyze: out-of-range alpha is a structured 422', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/analyze', {
    body: { camber: { kind: 'polynomial', coefficients: [0] }, alpha: 16 * (Math.PI / 180) },
  });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'ALPHA_OUT_OF_RANGE');
  assert.ok(body.error.details.limitDegrees === 15);
});

test('POST /analyze: allowOutOfRange flags but still computes', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const alpha = 0.3; // ~17.2 deg
  const { status, body } = await call(h, '/analyze', {
    body: { camber: { kind: 'polynomial', coefficients: [0] }, alpha, allowOutOfRange: true },
  });
  assert.equal(status, 200);
  assert.equal(body.outOfRange, true);
  assert.ok(Math.abs(body.cl - 2 * Math.PI * alpha) < 1e-9);
});

test('POST /analyze: non-monotonic points return typed error and no stack trace', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/analyze', {
    body: {
      camber: {
        kind: 'points',
        points: [
          { x: 0, z: 0 },
          { x: 0.8, z: 0.05 },
          { x: 0.2, z: 0.02 },
          { x: 1, z: 0 },
        ],
      },
      alpha: 0,
    },
  });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'NON_MONOTONIC_X');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.error.details.index, 2);
});

test('POST /analyze: unnormalised chord gives CHORD_NOT_NORMALIZED', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/analyze', {
    body: {
      camber: { kind: 'points', points: [{ x: 0, z: 0 }, { x: 2, z: 0.1 }] },
      alpha: 0,
    },
  });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'CHORD_NOT_NORMALIZED');
});

test('POST /sweep returns the whole Cl-alpha curve', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/sweep', {
    body: {
      profile: 'demo-parabola-5pct',
      alphaStart: -0.1,
      alphaEnd: 0.1,
      steps: 4,
    },
  });
  assert.equal(status, 200);
  assert.equal(body.count, 5);
  assert.ok(Math.abs(body.alphaL0 - -0.1) < 1e-9);
  // Cl should increase monotonically with alpha.
  for (let i = 1; i < body.points.length; i += 1) {
    assert.ok(body.points[i].cl > body.points[i - 1].cl);
  }
  // First point at alpha = -0.1 = alpha_L0 -> Cl ~ 0.
  assert.ok(Math.abs(body.points[0].cl) < 1e-9);
  // Cm constant along the sweep.
  for (const p of body.points) {
    assert.ok(Math.abs(p.cmQuarter - body.points[0].cmQuarter) < 1e-12);
  }
});

test('sweep with inverted range is INVALID_SWEEP; bad shape is INVALID_REQUEST', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const bad = await call(h, '/sweep', {
    body: { camber: { kind: 'polynomial', coefficients: [0] }, alphaStart: 0.2, alphaEnd: 0, steps: 5 },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_SWEEP');

  const ugly = await call(h, '/analyze', {
    body: { camber: { kind: 'polynomial' }, alpha: 0 },
  });
  assert.equal(ugly.status, 400);
  assert.equal(ugly.body.error.code, 'INVALID_REQUEST');
});

test('batch: one illegal geometry fails alone, every other point comes back', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/analyze/batch', {
    body: {
      items: [
        { id: 'good-sym', camber: { kind: 'polynomial', coefficients: [0] }, alpha: 0.05 },
        {
          id: 'bad-mono',
          camber: {
            kind: 'points',
            points: [
              { x: 0, z: 0 },
              { x: 0.5, z: 0.1 },
              { x: 0.4, z: 0 },
            ],
          },
        },
        { id: 'good-demo', profile: 'demo-parabola-5pct', alpha: 0 },
        {
          id: 'too-hot',
          camber: { kind: 'polynomial', coefficients: [0] },
          alpha: 0.5,
        },
        {
          id: 'too-hot-ok',
          camber: { kind: 'polynomial', coefficients: [0] },
          alpha: 0.5,
          allowOutOfRange: true,
        },
        { id: 'missing' },
      ],
    },
  });
  assert.equal(status, 200);
  const byId = new Map(body.results.map((r: any) => [r.id, r]));
  assert.equal(byId.get('good-sym').ok, true);
  assert.ok(Math.abs(byId.get('good-sym').cl - 0.1 * Math.PI) < 1e-9);
  assert.equal(byId.get('good-demo').ok, true);
  assert.ok(Math.abs(byId.get('good-demo').cl - 0.2 * Math.PI) < 1e-9);

  assert.equal(byId.get('bad-mono').ok, false);
  assert.equal(byId.get('bad-mono').error.code, 'NON_MONOTONIC_X');

  assert.equal(byId.get('too-hot').ok, false);
  assert.equal(byId.get('too-hot').error.code, 'ALPHA_OUT_OF_RANGE');

  assert.equal(byId.get('too-hot-ok').ok, true);
  assert.equal(byId.get('too-hot-ok').outOfRange, true);

  assert.equal(byId.get('missing').ok, false);
  assert.equal(byId.get('missing').error.code, 'MISSING_CAMBER');
});

test('profile lifecycle: create, use, duplicate 409, missing 404, delete', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  const created = await call(h, '/profiles', {
    body: { id: 'naca-ish', camber: { kind: 'polynomial', coefficients: [0, 0.16, -0.16, -0.032] } },
  });
  assert.equal(created.status, 201);

  const dup = await call(h, '/profiles', {
    body: { id: 'naca-ish', camber: { kind: 'polynomial', coefficients: [0] } },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'PROFILE_EXISTS');

  const used = await call(h, '/analyze', { body: { profile: 'naca-ish', alpha: 0 } });
  assert.equal(used.status, 200);

  const missing = await call(h, '/analyze', { body: { profile: 'ghost', alpha: 0 } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PROFILE_NOT_FOUND');

  const del = await call(h, '/profiles/naca-ish', { method: 'DELETE' });
  assert.equal(del.status, 204);

  const gone = await call(h, '/analyze', { body: { profile: 'naca-ish', alpha: 0 } });
  assert.equal(gone.status, 404);
});

test('malformed JSON body gives INVALID_JSON, not a crash', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/analyze', { raw: '{ not json' });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('unknown route gives structured 404', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const res = await fetch(`${h.base}/nope`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('concurrent requests never mix results or registrations', async (t) => {
  const h = await start();
  t.after(() => h.server.close());

  // Distinct cambers (different slopes) and distinct alphas in parallel.
  const jobs: Promise<any>[] = [];
  for (let i = 0; i < 24; i += 1) {
    const k = (i + 1) * 0.01;
    const alpha = (i % 7) * 0.01;
    jobs.push(
      call(h, '/analyze', {
        body: {
          camber: { kind: 'polynomial', coefficients: [0, 4 * k, -4 * k] },
          alpha,
        },
      }),
    );
  }
  const responses = await Promise.all(jobs);
  responses.forEach((r, i) => {
    assert.equal(r.status, 200, `job ${i}`);
    const k = (i + 1) * 0.01;
    const alpha = (i % 7) * 0.01;
    // alpha_L0 = -2k for this family
    assert.ok(Math.abs(r.body.alphaL0 - -2 * k) < 1e-9, `alphaL0 job ${i}`);
    assert.ok(Math.abs(r.body.cl - 2 * Math.PI * (alpha + 2 * k)) < 1e-9, `cl job ${i}`);
  });

  // Concurrent profile registrations.
  const creates = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call(h, '/profiles', {
        body: { id: `conc-${i}`, camber: { kind: 'polynomial', coefficients: [0, 0.01 * i] } },
      }),
    ),
  );
  for (const c of creates) assert.equal(c.status, 201);
  const list = await call(h, '/profiles', { method: 'GET' });
  for (let i = 0; i < 10; i += 1) {
    assert.ok(list.body.profiles.some((p: any) => p.id === `conc-${i}`));
  }
});

/* ------------------------- inverse design over HTTP ------------------------- */

test('POST /design/lift: inverse camber closes the loop through /analyze', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const alpha = 0.02;
  const cl = 0.45;
  const { status, body } = await call(h, '/design/lift', { body: { alpha, cl } });
  assert.equal(status, 200);
  assert.equal(body.camber.kind, 'points');
  assert.equal(body.criterion.name, 'minimum_slope_energy');
  assert.equal(body.verification.passed, true);
  assert.ok(body.verification.clError <= body.verification.tolerance.cl);

  // Hard closure: feed the returned camber straight back into /analyze.
  const back = await call(h, '/analyze', { body: { camber: body.camber, alpha } });
  assert.equal(back.status, 200);
  assert.ok(Math.abs(back.body.cl - cl) <= body.verification.tolerance.cl);
});

test('POST /design/lift with cm pins both and lists the moment constraint', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/design/lift', {
    body: { alpha: 0.03, cl: 0.5, cmQuarter: -0.05 },
  });
  assert.equal(status, 200);
  assert.ok(body.criterion.constraints.includes('cm_quarter_target'));
  const back = await call(h, '/analyze', { body: { camber: body.camber, alpha: 0.03 } });
  assert.ok(Math.abs(back.body.cl - 0.5) <= 2e-3);
  assert.ok(Math.abs(back.body.cmQuarter - -0.05) <= 5e-4);
});

test('POST /design/lift: symmetric + nonzero moment is a structured 422', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/design/lift', {
    body: { alpha: 0.05, cl: 0.3, cmQuarter: -0.04, symmetric: true },
  });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'TARGET_INCONSISTENT');
  assert.equal(body.error.details.symmetricSectionCmQuarter, 0);
});

test('POST /design/lift: wild lift is TARGET_UNREALIZABLE 422', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/design/lift', { body: { alpha: 0, cl: 3 } });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'TARGET_UNREALIZABLE');
  assert.ok(body.error.details.maxAllowedSlope !== undefined);
});

test('POST /design/lift with saveAs registers a reusable named profile', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const { status, body } = await call(h, '/design/lift', {
    body: { alpha: 0, cl: 0.4, saveAs: 'inv-cruise' },
  });
  assert.equal(status, 200);
  assert.equal(body.savedProfile.id, 'inv-cruise');

  // Reuse by profile id in the ordinary forward path and in a sweep.
  const byProfile = await call(h, '/analyze', { body: { profile: 'inv-cruise', alpha: 0 } });
  assert.equal(byProfile.status, 200);
  assert.ok(Math.abs(byProfile.body.cl - body.verification.cl) < 1e-9);

  const sweepRes = await call(h, '/sweep', {
    body: { profile: 'inv-cruise', alphaStart: -0.05, alphaEnd: 0.05, steps: 4 },
  });
  assert.equal(sweepRes.status, 200);
  assert.equal(sweepRes.body.count, 5);
});

test('POST /design/loading: shape target closes the loop and reuses as profile', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  // Pull a target trajectory off the demo profile.
  const demo = await call(h, '/analyze', {
    body: { profile: 'demo-parabola-5pct', alpha: 0.02, samples: 64 },
  });
  assert.equal(demo.status, 200);
  const loading = demo.body.loading.map((p: any) => ({ x: p.x, deltaCp: p.deltaCp }));

  const { status, body } = await call(h, '/design/loading', {
    body: { alpha: 0.02, loading, saveAs: 'inv-shape' },
  });
  assert.equal(status, 200);
  assert.equal(body.verification.passed, true);
  assert.ok(body.criterion.constraints.includes('loading_least_squares'));

  // Registered and retrievable.
  const got = await call(h, '/profiles/inv-shape', { method: 'GET' });
  assert.equal(got.status, 200);

  const back = await call(h, '/analyze', { body: { profile: 'inv-shape', alpha: 0.02 } });
  assert.ok(Math.abs(back.body.cl - body.verification.cl) <= 2e-3);
});

test('POST /design/loading: sparse/non-monotonic samples are rejected before solving', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const few = await call(h, '/design/loading', {
    body: { alpha: 0, loading: [{ x: 0.2, deltaCp: 1 }, { x: 0.6, deltaCp: 1 }] },
  });
  assert.equal(few.status, 422);
  assert.equal(few.body.error.code, 'LOADING_TOO_FEW_SAMPLES');

  const samples = Array.from({ length: 10 }, (_, i) => ({ x: 0.05 + i * 0.08, deltaCp: 1 }));
  samples[4].x = samples[2].x;
  const mono = await call(h, '/design/loading', { body: { alpha: 0, loading: samples } });
  assert.equal(mono.status, 422);
  assert.equal(mono.body.error.code, 'LOADING_NOT_MONOTONIC');
});

test('inverse endpoints: malformed body is INVALID_REQUEST', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const r = await call(h, '/design/lift', { body: { alpha: 0.05 } }); // missing cl
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_REQUEST');
});

test('concurrent inverse designs stay isolated and individually close the loop', async (t) => {
  const h = await start();
  t.after(() => h.server.close());
  const jobs: Promise<any>[] = [];
  for (let i = 0; i < 16; i += 1) {
    const cl = 0.2 + (i % 5) * 0.1;
    jobs.push(call(h, '/design/lift', { body: { alpha: 0.02, cl } }));
  }
  const responses = await Promise.all(jobs);
  for (let i = 0; i < responses.length; i += 1) {
    const r = responses[i];
    assert.equal(r.status, 200, `job ${i}`);
    assert.equal(r.body.verification.passed, true);
    const cl = 0.2 + (i % 5) * 0.1;
    assert.ok(Math.abs(r.body.verification.cl - cl) <= r.body.verification.tolerance.cl);
  }
});
