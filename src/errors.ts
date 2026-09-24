/**
 * Structured error types shared across validation, camber building,
 * analysis and the HTTP layer. Nothing in the service throws a raw
 * unknown error to a client: failures are always one of these codes.
 */

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  | 'NON_MONOTONIC_X'
  | 'TOO_FEW_POINTS'
  | 'INVALID_POLYNOMIAL'
  | 'CHORD_NOT_NORMALIZED'
  | 'INVALID_CHORD'
  | 'INVALID_ALPHA'
  | 'ALPHA_OUT_OF_RANGE'
  | 'INVALID_SWEEP'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_EXISTS'
  | 'INVALID_PROFILE_ID'
  | 'AMBIGUOUS_CAMBER'
  | 'MISSING_CAMBER'
  /* Inverse-design targets (see src/inverse.ts) */
  | 'TARGET_INCONSISTENT'
  | 'TARGET_UNREALIZABLE'
  | 'LOADING_TOO_FEW_SAMPLES'
  | 'LOADING_NOT_MONOTONIC'
  | 'LOADING_MALFORMED'
  | 'INVERSE_TOLERANCE_NOT_MET'
  | 'NOT_FOUND'
  | 'INTERNAL';

/** Single structured error entry inside a batch response. */
export interface StructuredError {
  code: ErrorCode;
  message: string;
  /** Optional machine-readable context (field names, offending values, limits). */
  details?: Record<string, unknown>;
}

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
    this.httpStatus = STATUS_BY_CODE[code];
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_JSON: 400,
  NON_MONOTONIC_X: 422,
  TOO_FEW_POINTS: 422,
  INVALID_POLYNOMIAL: 422,
  CHORD_NOT_NORMALIZED: 422,
  INVALID_CHORD: 422,
  INVALID_ALPHA: 400,
  ALPHA_OUT_OF_RANGE: 422,
  INVALID_SWEEP: 400,
  PROFILE_NOT_FOUND: 404,
  PROFILE_EXISTS: 409,
  INVALID_PROFILE_ID: 400,
  AMBIGUOUS_CAMBER: 400,
  MISSING_CAMBER: 400,
  TARGET_INCONSISTENT: 422,
  TARGET_UNREALIZABLE: 422,
  LOADING_TOO_FEW_SAMPLES: 422,
  LOADING_NOT_MONOTONIC: 422,
  LOADING_MALFORMED: 422,
  INVERSE_TOLERANCE_NOT_MET: 422,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export function toErrorBody(err: ServiceError): { error: StructuredError } {
  const body: { error: StructuredError } = {
    error: { code: err.code, message: err.message },
  };
  if (err.details !== undefined) {
    body.error.details = err.details;
  }
  return body;
}

export function isServiceError(err: unknown): err is ServiceError {
  return err instanceof ServiceError;
}
