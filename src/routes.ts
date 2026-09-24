/**
 * HTTP routes. All endpoints speak JSON; there is no UI.
 *
 *   POST /analyze                 single geometry + single alpha
 *   POST /analyze/batch           many independent geometry/alpha jobs
 *   POST /sweep                   one geometry over an alpha interval
 *   POST /inverse                 invert aerodynamic targets into a camber
 *   GET  /profiles                list named profiles
 *   POST /profiles                register a named profile
 *   GET  /profiles/:id            fetch one
 *   DELETE /profiles/:id          remove one
 *   GET  /healthz                 liveness
 *
 * Batch jobs are isolated: a bad geometry or out-of-range alpha fails only
 * that item; every other item is still computed and returned.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { ProfileStore } from './profileStore';
import {
  parseAnalyze,
  parseBatch,
  parseCreateProfile,
  parseInverse,
  parseSweep,
} from './validation';
import { evaluate, inverse, sweep } from './service';
import { ServiceError, StructuredError, toErrorBody } from './errors';

export function createRouter(store: ProfileStore): Router {
  const router = Router();

  router.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', profiles: store.list().length });
  });

  /* ------------------------------ analyze ----------------------------- */

  router.post('/analyze', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseAnalyze(req.body);
      const { result, outOfRange } = evaluate(store, body);
      res.json({
        alpha: result.alpha,
        alphaL0: result.alphaL0,
        cl: result.cl,
        cmQuarter: result.cmQuarter,
        coefficients: result.coefficients,
        loading: result.loading,
        loadingIntegralCl: result.loadingIntegralCl,
        outOfRange,
      });
    } catch (err) {
      next(err);
    }
  });

  /* --------------------------- analyze batch -------------------------- */

  router.post('/analyze/batch', (req: Request, res: Response, next: NextFunction) => {
    let items: ReturnType<typeof parseBatch>['items'];
    try {
      items = parseBatch(req.body).items;
    } catch (err) {
      next(err);
      return;
    }

    const response = items.map((item) => {
      const base = { id: item.id };
      try {
        const { result, outOfRange } = evaluate(store, {
          camber: item.camber,
          profile: item.profile,
          alpha: item.alpha,
          allowOutOfRange: item.allowOutOfRange ?? false,
          samples: item.samples,
        });
        return {
          ...base,
          ok: true as const,
          alpha: result.alpha,
          alphaL0: result.alphaL0,
          cl: result.cl,
          cmQuarter: result.cmQuarter,
          coefficients: result.coefficients,
          loading: result.loading,
          loadingIntegralCl: result.loadingIntegralCl,
          outOfRange,
        };
      } catch (err) {
        const structured = toStructured(err);
        return { ...base, ok: false as const, error: structured };
      }
    });

    res.json({ results: response });
  });

  /* ------------------------------- sweep ------------------------------ */

  router.post('/sweep', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseSweep(req.body);
      const { alphaL0, points } = sweep(store, body);
      res.json({
        alphaL0,
        alphaStart: body.alphaStart,
        alphaEnd: body.alphaEnd,
        steps: body.steps,
        count: points.length,
        points: points.map((p) => ({
          alpha: p.alpha,
          cl: p.result.cl,
          cmQuarter: p.result.cmQuarter,
          outOfRange: p.outOfRange,
          ...(p.result.loading ? { loading: p.result.loading } : {}),
          ...(p.result.loading !== undefined
            ? { loadingIntegralCl: p.result.loadingIntegralCl }
            : {}),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /* ------------------------------ inverse ----------------------------- */

  router.post('/inverse', (req: Request, res: Response, next: NextFunction) => {
    let body;
    try {
      body = parseInverse(req.body);
    } catch (err) {
      next(err);
      return;
    }
    inverse(store, body)
      .then(({ result, registered }) => {
        res.status(registered ? 201 : 200).json({
          target: result.target,
          camber: result.camber,
          selectionCriterion: result.selectionCriterion,
          prediction: result.prediction,
          verification: result.verification,
          diagnostics: result.diagnostics,
          outOfRange: result.outOfRange,
          ...(registered && body.register
            ? { profile: { id: body.register.id } }
            : {}),
        });
      })
      .catch(next);
  });

  /* ----------------------------- profiles ----------------------------- */

  router.get('/profiles', (_req: Request, res: Response) => {
    res.json({ profiles: store.list() });
  });

  router.post('/profiles', (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseCreateProfile(req.body);
      store
        .create(body)
        .then((profile) => res.status(201).json({ profile }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  router.get('/profiles/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = store.get(req.params.id);
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/profiles/:id', (req: Request, res: Response, next: NextFunction) => {
    store
      .delete(req.params.id)
      .then(() => res.status(204).end())
      .catch(next);
  });

  return router;
}

function toStructured(err: unknown): StructuredError {
  if (err instanceof ServiceError) {
    return toErrorBody(err).error;
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return { code: 'INTERNAL', message };
}
