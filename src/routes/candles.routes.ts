import { Router } from 'express';
import { z } from 'zod';
import { CandleInterval } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ok } from '../lib/http.js';
import { HttpError } from '../middleware/errorHandler.js';

export const candlesRouter: Router = Router();

const intervalMap: Record<string, CandleInterval> = {
  '1m': CandleInterval.ONE_MIN,
  '5m': CandleInterval.FIVE_MIN,
  '1h': CandleInterval.ONE_HOUR,
  '1d': CandleInterval.ONE_DAY,
};

const querySchema = z.object({
  interval: z.enum(['1m', '5m', '1h', '1d']).default('1m'),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

candlesRouter.get('/:mint/candles', async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!mint) throw new HttpError(400, 'mint is required');
    const q = querySchema.parse(req.query);
    const interval = intervalMap[q.interval];
    if (!interval) throw new HttpError(400, 'unknown interval');

    const where: { tokenMint: string; interval: CandleInterval; bucketStart?: { gte?: Date; lte?: Date } } = {
      tokenMint: mint,
      interval,
    };
    if (q.from || q.to) {
      const range: { gte?: Date; lte?: Date } = {};
      if (q.from !== undefined) range.gte = new Date(q.from * 1000);
      if (q.to !== undefined) range.lte = new Date(q.to * 1000);
      where.bucketStart = range;
    }

    const rows = await prisma.candle.findMany({
      where,
      orderBy: { bucketStart: 'asc' },
      take: q.limit,
    });

    // TradingView lightweight-charts format
    const candles = rows.map((c) => ({
      time: Math.floor(c.bucketStart.getTime() / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumeUsd,
    }));
    ok(res, candles);
  } catch (err) {
    next(err);
  }
});
