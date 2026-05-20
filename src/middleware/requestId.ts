import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
    log?: ReturnType<typeof logger.child>;
  }
}

const HEADER = 'x-request-id';

/**
 * Tag every request with a UUID (honoring an inbound `x-request-id` if present)
 * and attach a child logger pre-bound to that id. Downstream code that pulls
 * `req.log` gets every line correlated automatically.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER);
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
  req.id = id;
  req.log = logger.child({ reqId: id });
  res.setHeader(HEADER, id);
  next();
};
