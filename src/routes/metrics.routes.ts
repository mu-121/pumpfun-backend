import { Router } from 'express';
import { registry, wsConnectedClients } from '../lib/metrics.js';
import { getIo } from '../lib/ws.js';

export const metricsRouter: Router = Router();

/**
 * Prometheus scrape endpoint. Plain-text, no auth — bind to a private VPC IP
 * in prod or stick it behind a reverse-proxy ACL.
 */
metricsRouter.get('/metrics', async (_req, res, next) => {
  try {
    const io = getIo();
    wsConnectedClients.set(io?.engine.clientsCount ?? 0);
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  } catch (err) {
    next(err);
  }
});
