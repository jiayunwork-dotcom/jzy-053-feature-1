/**
 * Express application assembly: JSON parsing, routes and a single error
 * boundary that converts every failure into a structured error envelope.
 */

import express, { Application, NextFunction, Request, Response } from 'express';
import { ProfileStore } from './profileStore';
import { createRouter } from './routes';
import { isServiceError, ServiceError, toErrorBody } from './errors';

export async function createApp(store: ProfileStore): Promise<Application> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(createRouter(store));

  // Unknown routes (registered before the error boundary).
  app.use((_req: Request, res: Response) => {
    const se = new ServiceError('NOT_FOUND', 'No such endpoint');
    res.status(se.httpStatus).json(toErrorBody(se));
  });

  // Malformed JSON bodies.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      const se = new ServiceError('INVALID_JSON', 'Request body is not valid JSON', {
        message: err.message,
      });
      res.status(se.httpStatus).json(toErrorBody(se));
      return;
    }
    next(err);
  });

  // Final error boundary.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const se = isServiceError(err)
      ? err
      : new ServiceError(
          'INTERNAL',
          err instanceof Error ? err.message : 'Unexpected internal error',
        );
    res.status(se.httpStatus).json(toErrorBody(se));
  });

  return app;
}
