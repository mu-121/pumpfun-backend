import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { fail } from '../lib/http.js';
import { logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: 'NotFound',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    fail(res, 400, {
      code: 'ValidationError',
      message: 'Invalid request',
      details: err.issues,
    });
    return;
  }

  if (err instanceof HttpError) {
    logger.warn({ err, path: req.path, method: req.method }, 'http error');
    fail(res, err.status, {
      code: err.name,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({
    error: 'InternalServerError',
    message: 'An unexpected error occurred',
  });
};
