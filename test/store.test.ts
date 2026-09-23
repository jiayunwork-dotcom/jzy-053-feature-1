/**
 * Profile registry tests: CRUD, persistence across a simulated restart
 * (reopen the same file), demo seeding and duplicate handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileStore, DEMO_PROFILE } from '../src/profileStore';
import { ServiceError } from '../src/errors';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taps-store-'));
  return path.join(dir, 'profiles.json');
}

test('fresh store seeds the hand-checkable demo profile', async () => {
  const store = await ProfileStore.open({ filePath: await tempFile() });
  const demo = store.get('demo-parabola-5pct');
  assert.deepEqual(demo.camber, DEMO_PROFILE.camber);
  assert.ok(store.list().length >= 1);
});

test('registered profile survives a restart and is retrievable by name', async () => {
  const file = await tempFile();
  const store1 = await ProfileStore.open({ filePath: file });
  await store1.create({
    id: 'my-line',
    name: 'Mine',
    camber: { kind: 'polynomial', coefficients: [0, 0.1, -0.1] },
  });

  const store2 = await ProfileStore.open({ filePath: file });
  const p = store2.get('my-line');
  assert.equal(p.name, 'Mine');
  assert.deepEqual(p.camber, { kind: 'polynomial', coefficients: [0, 0.1, -0.1] });
  // Demo profile is also still there.
  assert.ok(store2.has('demo-parabola-5pct'));
});

test('duplicate ids are rejected with PROFILE_EXISTS', async () => {
  const store = await ProfileStore.open({ filePath: await tempFile() });
  await assert.rejects(
    () =>
      store.create({
        id: 'demo-parabola-5pct',
        camber: { kind: 'polynomial', coefficients: [0] },
      }),
    (err: unknown) => err instanceof ServiceError && err.code === 'PROFILE_EXISTS',
  );
});

test('unknown profile id is PROFILE_NOT_FOUND', async () => {
  const store = await ProfileStore.open({ filePath: await tempFile() });
  assert.throws(
    () => store.get('nope'),
    (err: unknown) => err instanceof ServiceError && err.code === 'PROFILE_NOT_FOUND',
  );
  await assert.rejects(
    () => store.delete('nope'),
    (err: unknown) => err instanceof ServiceError && err.code === 'PROFILE_NOT_FOUND',
  );
});

test('creating a profile with invalid geometry does not persist it', async () => {
  const store = await ProfileStore.open({ filePath: await tempFile() });
  await assert.rejects(
    () =>
      store.create({
        id: 'bad',
        camber: {
          kind: 'points',
          points: [
            { x: 0, z: 0 },
            { x: 0.9, z: 0 },
            { x: 0.2, z: 0 },
          ],
        },
      }),
    (err: unknown) => err instanceof ServiceError && err.code === 'NON_MONOTONIC_X',
  );
  assert.equal(store.has('bad'), false);
});

test('delete removes a profile and persists', async () => {
  const file = await tempFile();
  const store1 = await ProfileStore.open({ filePath: file });
  await store1.create({ id: 'temp', camber: { kind: 'polynomial', coefficients: [0.02] } });
  await store1.delete('temp');
  const store2 = await ProfileStore.open({ filePath: file });
  assert.equal(store2.has('temp'), false);
});

test('persisted document is valid JSON containing the profiles', async () => {
  const file = await tempFile();
  const store = await ProfileStore.open({ filePath: file });
  await store.create({ id: 'p1', camber: { kind: 'polynomial', coefficients: [0, 0.1] } });
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.ok(doc.profiles.some((p: { id: string }) => p.id === 'p1'));
});
