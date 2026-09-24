/**
 * Application service layer: resolves camber references (inline geometry
 * vs named stored profile) and runs the aerodynamic kernel. Purely
 * synchronous compute — concurrent requests never share mutable state
 * (each call builds its own model and result object).
 */

import { CamberDef } from './types';
import { buildCamberModel } from './camber';
import { analyze, AnalysisResult, checkAlpha, zeroLiftAngle } from './analyze';
import { ProfileStore } from './profileStore';
import { resolveCamberRef } from './validation';
import {
  designForScalars,
  designForLoading,
  InverseResult,
  ScalarTarget,
  LoadingTarget,
} from './inverse';
import { ServiceError } from './errors';

export interface SweepPoint {
  alpha: number;
  outOfRange: boolean;
  result: Omit<AnalysisResult, 'loading'> & { loading?: AnalysisResult['loading'] };
}

function resolveModel(
  store: ProfileStore,
  ref: { camber?: CamberDef; profile?: string },
) {
  const resolved = resolveCamberRef(ref);
  if (resolved.profile !== undefined) {
    const stored = store.get(resolved.profile);
    return buildCamberModel(stored.camber);
  }
  return buildCamberModel(resolved.camber as CamberDef);
}

export interface EvaluateOptions {
  camber?: CamberDef;
  profile?: string;
  alpha: number;
  allowOutOfRange: boolean;
  samples?: number;
}

export function evaluate(store: ProfileStore, opts: EvaluateOptions) {
  const model = resolveModel(store, opts);
  const { alpha, outOfRange } = checkAlpha(opts.alpha, opts.allowOutOfRange);
  const result = analyze({ model, alpha }, opts.samples ?? 129);
  return { result, outOfRange, alphaL0: zeroLiftAngle(model) };
}

/**
 * Sweep alpha over [alphaStart, alphaEnd] with `steps` INTERVALS, i.e.
 * steps+1 evenly spaced points (inclusive endpoints). The geometry is
 * built exactly once. Out-of-range points are flagged or refused per
 * `allowOutOfRange`.
 */
export function sweep(
  store: ProfileStore,
  opts: {
    camber?: CamberDef;
    profile?: string;
    alphaStart: number;
    alphaEnd: number;
    steps: number;
    allowOutOfRange: boolean;
    includeLoading: boolean;
    samples?: number;
  },
): { alphaL0: number; points: SweepPoint[] } {
  const model = resolveModel(store, opts);
  const alphaL0 = zeroLiftAngle(model);
  const points: SweepPoint[] = [];

  const denom = opts.steps; // >= 1 guaranteed by validation
  for (let i = 0; i <= opts.steps; i += 1) {
    const alpha = opts.alphaStart + ((opts.alphaEnd - opts.alphaStart) * i) / denom;
    const { outOfRange } = checkAlpha(alpha, opts.allowOutOfRange);
    const result = analyze({ model, alpha }, opts.samples ?? 129);
    if (opts.includeLoading) {
      points.push({ alpha, outOfRange, result });
    } else {
      const { loading: _loading, ...summary } = result;
      points.push({ alpha, outOfRange, result: summary });
    }
  }
  return { alphaL0, points };
}

/** Re-export for convenience of callers/tests. */
export { ServiceError };

/**
 * Run an inverse design (scalar or loading target) and, when `saveAs` is
 * given, register the resulting camber as a named profile so it can be
 * reused by /analyze, /sweep and /analyze/batch. The geometry is always one
 * of the two existing camber representations (discrete points), so it slots
 * straight into the existing registry without a parallel type.
 */
export async function inverseDesign(
  store: ProfileStore,
  request: (ScalarTarget | LoadingTarget) & { saveAs?: string; name?: string; description?: string },
): Promise<{ result: InverseResult; saved?: import('./profileStore').StoredProfile }> {
  const result =
    'loading' in request
      ? designForLoading(request as LoadingTarget)
      : designForScalars(request as ScalarTarget);

  let saved;
  if (request.saveAs !== undefined) {
    saved = await store.create({
      id: request.saveAs,
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      camber: result.camber,
    });
  }
  return { result, ...(saved !== undefined ? { saved } : {}) };
}
