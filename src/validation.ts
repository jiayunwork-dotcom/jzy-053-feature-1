/**
 * Request validation (HTTP boundary).
 *
 * Zod shapes every wire payload. Structural problems become a single
 * INVALID_REQUEST error listing every offending field; geometry that is
 * structurally valid but physically non-conforming is detected later by
 * buildCamberModel and reported with its specific code (NON_MONOTONIC_X,
 * TOO_FEW_POINTS, CHORD_NOT_NORMALIZED, ...).
 */

import { z } from 'zod';
import { CamberDef } from './types';
import { ServiceError } from './errors';

const finiteNumber = z.number();

const pointSchema = z
  .object({
    x: finiteNumber,
    z: finiteNumber,
  })
  .strict();

const polynomialSchema = z
  .object({
    kind: z.literal('polynomial'),
    coefficients: z.array(finiteNumber),
  })
  .strict();

const pointsSchema = z
  .object({
    kind: z.literal('points'),
    points: z.array(pointSchema),
    chord: finiteNumber.optional(),
  })
  .strict();

const camberSchema = z.union([polynomialSchema, pointsSchema]);

/** Camber supplied inline with the request, OR a named stored profile. */
const camberRefSchema = z
  .object({
    camber: camberSchema.optional(),
    profile: z.string().min(1).optional(),
  })
  .strict();

const analyzeBodySchema = camberRefSchema.extend({
  alpha: finiteNumber.optional().default(0),
  allowOutOfRange: z.boolean().optional().default(false),
  samples: z.number().int().min(8).max(1024).optional(),
});

const sweepBodySchema = camberRefSchema.extend({
  alphaStart: finiteNumber,
  alphaEnd: finiteNumber,
  steps: z.number().int().min(1).max(2000),
  allowOutOfRange: z.boolean().optional().default(false),
  includeLoading: z.boolean().optional().default(false),
  samples: z.number().int().min(8).max(1024).optional(),
});

const batchItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    camber: camberSchema.optional(),
    profile: z.string().min(1).optional(),
    alpha: finiteNumber.optional().default(0),
    allowOutOfRange: z.boolean().optional(),
    samples: z.number().int().min(8).max(1024).optional(),
  })
  .strict();

const batchBodySchema = z
  .object({
    items: z.array(batchItemSchema).min(1).max(256),
  })
  .strict();

const profileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, {
    message: 'Profile id must start with a letter or digit and contain only letters, digits, _ . -',
  });

const createProfileBodySchema = z
  .object({
    id: profileIdSchema,
    name: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    camber: camberSchema,
  })
  .strict();

export interface AnalyzeRequest {
  camber?: CamberDef;
  profile?: string;
  alpha: number;
  allowOutOfRange: boolean;
  samples?: number;
}

export interface SweepRequest {
  camber?: CamberDef;
  profile?: string;
  alphaStart: number;
  alphaEnd: number;
  steps: number;
  allowOutOfRange: boolean;
  includeLoading: boolean;
  samples?: number;
}

export interface BatchItemRequest {
  id?: string | number;
  camber?: CamberDef;
  profile?: string;
  alpha: number;
  allowOutOfRange?: boolean;
  samples?: number;
}

export interface CreateProfileRequest {
  id: string;
  name?: string;
  description?: string;
  camber: CamberDef;
}

function formatZod(err: z.ZodError): ServiceError {
  const fields = err.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
  return new ServiceError(
    'INVALID_REQUEST',
    fields.map((f) => `${f.path}: ${f.message}`).join('; '),
    { fields },
  );
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw formatZod(result.error);
  }
  return result.data;
}

export function parseAnalyze(body: unknown): AnalyzeRequest {
  return parse(analyzeBodySchema, body) as AnalyzeRequest;
}

export function parseSweep(body: unknown): SweepRequest {
  const req = parse(sweepBodySchema, body) as SweepRequest;
  if (!(req.alphaEnd >= req.alphaStart)) {
    throw new ServiceError(
      'INVALID_SWEEP',
      'alphaEnd must be greater than or equal to alphaStart (radians)',
      { alphaStart: req.alphaStart, alphaEnd: req.alphaEnd },
    );
  }
  return req;
}

export function parseBatch(body: unknown): { items: BatchItemRequest[] } {
  return parse(batchBodySchema, body) as { items: BatchItemRequest[] };
}

export function parseCreateProfile(body: unknown): CreateProfileRequest {
  return parse(createProfileBodySchema, body) as CreateProfileRequest;
}

/** Exactly one of inline camber / stored profile reference must be present. */
export function resolveCamberRef(ref: {
  camber?: CamberDef;
  profile?: string;
}): { camber?: CamberDef; profile?: string } {
  const hasCamber = ref.camber !== undefined;
  const hasProfile = ref.profile !== undefined;
  if (hasCamber && hasProfile) {
    throw new ServiceError(
      'AMBIGUOUS_CAMBER',
      "Provide either 'camber' or 'profile', not both",
    );
  }
  if (!hasCamber && !hasProfile) {
    throw new ServiceError(
      'MISSING_CAMBER',
      "Provide either an inline 'camber' definition or a stored 'profile' id",
    );
  }
  return ref;
}
