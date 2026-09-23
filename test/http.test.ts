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
