import { Queue, Worker, type Job } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { CandleInterval, Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const QUEUE_NAME = 'aggregator';
const RUN_EVERY_MS = 60_000;
const LOOKBACK_MS = 10 * 60_000;

const INTERVAL_MS: Record<CandleInterval, number> = {
  [CandleInterval.ONE_MIN]: 60_000,
  [CandleInterval.FIVE_MIN]: 5 * 60_000,
  [CandleInterval.ONE_HOUR]: 60 * 60_000,
  [CandleInterval.ONE_DAY]: 24 * 60 * 60_000,
};

function makeConn(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const aggregatorQueue: Queue = new Queue(QUEUE_NAME, { connection: makeConn() });

function bucketStart(at: Date, intervalMs: number): Date {
  return new Date(Math.floor(at.getTime() / intervalMs) * intervalMs);
}

/**
 * Recompute OHLCV candles for the recent window. For every (token, interval,
 * bucket) covered by trades in the last 10 minutes, we upsert a Candle row.
 * Idempotent — running it twice on the same window yields the same data.
 */
export async function aggregateRecentCandles(): Promise<void> {
  const lookbackStart = new Date(Date.now() - LOOKBACK_MS);
  const trades = await prisma.trade.findMany({
    where: { blockTime: { gte: lookbackStart } },
    orderBy: { blockTime: 'asc' },
    select: {
      tokenMint: true,
      blockTime: true,
      priceSol: true,
      priceUsd: true,
      solAmount: true,
    },
  });
  if (trades.length === 0) return;

  // Group by (mint, interval, bucket)
  type Agg = {
    open: number;
    high: number;
    low: number;
    close: number;
    volumeSol: number;
    volumeUsd: number;
    trades: number;
  };
  const groups = new Map<string, Agg & { mint: string; interval: CandleInterval; bucket: Date }>();
  const intervals = Object.values(CandleInterval) as CandleInterval[];

  for (const t of trades) {
    const solAmountSol = Number(t.solAmount) / 1e9;
    const volUsd = solAmountSol * (t.priceUsd > 0 && t.priceSol > 0 ? t.priceUsd / t.priceSol : 0);
    for (const interval of intervals) {
      const ms = INTERVAL_MS[interval];
      const bucket = bucketStart(t.blockTime, ms);
      const key = `${t.tokenMint}|${interval}|${bucket.getTime()}`;
      const prev = groups.get(key);
      if (prev) {
        prev.high = Math.max(prev.high, t.priceUsd);
        prev.low = Math.min(prev.low, t.priceUsd);
        prev.close = t.priceUsd;
        prev.volumeSol += solAmountSol;
        prev.volumeUsd += volUsd;
        prev.trades += 1;
      } else {
        groups.set(key, {
          mint: t.tokenMint,
          interval,
          bucket,
          open: t.priceUsd,
          high: t.priceUsd,
          low: t.priceUsd,
          close: t.priceUsd,
          volumeSol: solAmountSol,
          volumeUsd: volUsd,
          trades: 1,
        });
      }
    }
  }

  // Upsert. We don't want a new aggregator pass to clobber `open`, so on update
  // we only refresh high/low/close/volume/trades.
  let written = 0;
  for (const g of groups.values()) {
    try {
      await prisma.candle.upsert({
        where: {
          tokenMint_interval_bucketStart: {
            tokenMint: g.mint,
            interval: g.interval,
            bucketStart: g.bucket,
          },
        },
        create: {
          tokenMint: g.mint,
          interval: g.interval,
          bucketStart: g.bucket,
          open: g.open,
          high: g.high,
          low: g.low,
          close: g.close,
          volumeSol: g.volumeSol,
          volumeUsd: g.volumeUsd,
          trades: g.trades,
        },
        update: {
          high: { set: g.high },
          low: { set: g.low },
          close: g.close,
          volumeSol: g.volumeSol,
          volumeUsd: g.volumeUsd,
          trades: g.trades,
        } satisfies Prisma.CandleUpdateInput,
      });
      written += 1;
    } catch (err) {
      logger.warn({ err, mint: g.mint, interval: g.interval }, 'aggregator: upsert failed');
    }
  }
  logger.debug({ buckets: groups.size, written }, 'aggregator: pass complete');
}

/**
 * Boot the aggregator: schedule a repeatable job and start the worker that runs it.
 * The repeatable job-id ensures only one schedule is registered even on restart.
 */
export async function startAggregator(): Promise<Worker> {
  await aggregatorQueue.add(
    'run',
    {},
    {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'aggregator:repeating',
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      await aggregateRecentCandles();
    },
    { connection: makeConn(), concurrency: 1 },
  );
  worker.on('error', (err) => logger.error({ err }, 'aggregator worker error'));
  logger.info({ queue: QUEUE_NAME, everyMs: RUN_EVERY_MS }, 'aggregator started');
  return worker;
}
