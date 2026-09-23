/**
 * Named camber-line profile registry with disk persistence.
 *
 * Profiles survive process restarts: the registry is held in memory and
 * mirrored to a single JSON document written atomically (temp file +
 * rename). Writes are serialised through a promise chain so concurrent
 * registrations cannot interleave or corrupt the document.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { CamberDef } from './types';
import { ServiceError } from './errors';
import { buildCamberModel } from './camber';

export interface StoredProfile {
  id: string;
  name?: string;
  description?: string;
  camber: CamberDef;
  createdAt: string;
  updatedAt: string;
}

interface ProfileDocument {
  version: 1;
  profiles: StoredProfile[];
}

/**
 * The hand-checkable demonstration profile.
 *
 * z(x) = 4 h x (1 - x), h = 0.05: a simple parabolic camber with 5%
 * maximum camber at mid-chord.  eta = dz/dx = 4h(1 - 2x) = 4h cos theta.
 *
 * Hand calculation:
 *   m0 = (1/pi) int_0^pi 4h cos theta d theta    = 0
 *   m1 = (1/pi) int_0^pi 4h cos^2 theta d theta  = 2h
 *   alpha_L0 = m0 - m1 = -2h                     = -0.10 rad
 *   A1 = 2 m1 = 4h = 0.20,  A2 = 0
 *   Cl(alpha=0) = 2 pi (0 - alpha_L0) = 0.2 pi   ~= 0.6283 (positive lift)
 *   Cm_{c/4} = (pi/4)(A2 - A1) = -0.05 pi        ~= -0.15708
 */
export const DEMO_PROFILE: StoredProfile = {
  id: 'demo-parabola-5pct',
  name: 'Parabolic camber, 5% maximum at mid-chord',
  description:
    'z(x) = 0.2 x (1 - x). Hand-checkable: alpha_L0 = -0.10 rad, Cl(0) = 0.2*pi ~= 0.6283, Cm,c/4 = -0.05*pi ~= -0.1571.',
  camber: {
    kind: 'polynomial',
    coefficients: [0, 0.2, -0.2],
  },
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
};

export interface ProfileStoreOptions {
  filePath: string;
  seed?: StoredProfile[];
}

export class ProfileStore {
  private readonly filePath: string;
  private profiles = new Map<string, StoredProfile>();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load (or initialise) the store. Seeds demo data only on first creation. */
  static async open(options: ProfileStoreOptions): Promise<ProfileStore> {
    const store = new ProfileStore(options.filePath);
    await fs.mkdir(path.dirname(options.filePath), { recursive: true });

    let raw: string | null = null;
    try {
      raw = await fs.readFile(options.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === null) {
      const seed = options.seed ?? [DEMO_PROFILE];
      for (const p of seed) {
        ProfileStore.assertValidProfile(p);
        store.profiles.set(p.id, p);
      }
      await store.persist();
    } else {
      let doc: ProfileDocument;
      try {
        doc = JSON.parse(raw) as ProfileDocument;
      } catch {
        throw new ServiceError(
          'INTERNAL',
          `Profile document at ${options.filePath} is not valid JSON`,
        );
      }
      if (!doc || doc.version !== 1 || !Array.isArray(doc.profiles)) {
        throw new ServiceError('INTERNAL', 'Profile document has an unsupported format', {
          filePath: options.filePath,
        });
      }
      for (const p of doc.profiles) {
        ProfileStore.assertValidProfile(p);
        store.profiles.set(p.id, p);
      }
      // Backfill any missing seed profiles without touching user data.
      let changed = false;
      for (const s of options.seed ?? [DEMO_PROFILE]) {
        if (!store.profiles.has(s.id)) {
          store.profiles.set(s.id, s);
          changed = true;
        }
      }
      if (changed) await store.persist();
    }
    return store;
  }

  list(): StoredProfile[] {
    return [...this.profiles.values()];
  }

  get(id: string): StoredProfile {
    const p = this.profiles.get(id);
    if (!p) {
      throw new ServiceError('PROFILE_NOT_FOUND', `No stored camber profile with id '${id}'`, { id });
    }
    return p;
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  async create(input: {
    id: string;
    name?: string;
    description?: string;
    camber: CamberDef;
  }): Promise<StoredProfile> {
    if (this.profiles.has(input.id)) {
      throw new ServiceError('PROFILE_EXISTS', `Profile '${input.id}' already exists`, {
        id: input.id,
      });
    }
    // Validate geometry before storing anything.
    buildCamberModel(input.camber);

    const now = new Date().toISOString();
    const profile: StoredProfile = {
      id: input.id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      camber: input.camber,
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.set(profile.id, profile);
    await this.persist();
    return profile;
  }

  async delete(id: string): Promise<void> {
    if (!this.profiles.has(id)) {
      throw new ServiceError('PROFILE_NOT_FOUND', `No stored camber profile with id '${id}'`, { id });
    }
    this.profiles.delete(id);
    await this.persist();
  }

  /** Atomically (tmp + rename) serialise the current registry. */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const doc: ProfileDocument = { version: 1, profiles: this.list() };
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }

  private static assertValidProfile(p: StoredProfile): void {
    if (!p || typeof p.id !== 'string' || !p.camber) {
      throw new ServiceError('INTERNAL', 'Stored profile is malformed');
    }
    buildCamberModel(p.camber);
  }
}
