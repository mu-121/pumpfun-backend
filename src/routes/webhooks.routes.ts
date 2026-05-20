import { Router } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../middleware/errorHandler.js';
import { enqueueWebhookBatch, type HeliusTxLike } from '../workers/indexer.js';

export const webhooksRouter: Router = Router();

webhooksRouter.post('/helius', async (req, res, next) => {
  try {
    const auth = req.header('authorization') ?? req.header('Authorization');
    if (!auth) throw new HttpError(401, 'Missing Authorization header');

    // Helius lets you configure either a raw secret in the header field, or a
    // Bearer-prefixed value. Accept both.
    const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : auth.trim();
    if (provided !== env.WEBHOOK_AUTH_SECRET) {
      throw new HttpError(401, 'Invalid webhook secret');
    }

    const body = req.body;
    if (!Array.isArray(body)) {
      throw new HttpError(400, 'Webhook body must be an array of transactions');
    }
    await enqueueWebhookBatch(body as HeliusTxLike[]);
    logger.info({ count: body.length }, 'webhook: enqueued helius batch');

    // Helius retries on non-2xx — ack immediately, do the work async.
    res.status(202).json({ accepted: body.length });
  } catch (err) {
    next(err);
  }
});
