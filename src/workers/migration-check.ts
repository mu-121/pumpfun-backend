import { Queue, Worker, type Job } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { PublicKey } from '@solana/web3.js';
import { deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { publish } from '../lib/redis.js';
import { dbc } from '../lib/dbc.js';
import { WSOL_MINT } from '../lib/solana.js';
import { Channels } from '../lib/ws.js';
import { graduationCount } from '../lib/metrics.js';

const QUEUE_NAME = 'migration-check';
const RUN_EVERY_MS = 30_000;
const COMPLETE_RATIO = 0.999;

function makeConn(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export const migrationCheckQueue: Queue = new Queue(QUEUE_NAME, { connection: makeConn() });

/**
 * Safety-net cron: every 30s, scan every non-graduated Token, pull its on-chain
 * curve-progress, and flip `isGraduated` if the curve has actually completed.
 *
 * This exists for the case where the Helius webhook missed the
 * `evtCurveComplete` event (delivery failure, ngrok hiccup, restart window).
 */
export async function checkGraduations(): Promise<void> {
  const tokens = await prisma.token.findMany({
    where: { isGraduated: false },
    select: { mintAddress: true, poolAddress: true, configKey: true },
    take: 500,
  });
  if (tokens.length === 0) return;

  for (const t of tokens) {
    try {
      const pool = new PublicKey(t.poolAddress);
      const progress = await dbc.state.getPoolQuoteTokenCurveProgress(pool);
      if (progress < COMPLETE_RATIO) continue;

      const graduatedPoolAddress = deriveDammV2PoolAddress(
        new PublicKey(t.configKey),
        new PublicKey(t.mintAddress),
        WSOL_MINT,
      ).toBase58();

      const updated = await prisma.token.update({
        where: { mintAddress: t.mintAddress },
        data: {
          isGraduated: true,
          graduatedAt: new Date(),
          graduatedPoolAddress,
        },
      });
      graduationCount.inc();
      await publish(Channels.graduation(t.mintAddress), {
        mintAddress: t.mintAddress,
        poolAddress: t.poolAddress,
        graduatedPoolAddress,
        blockTime: updated.graduatedAt?.toISOString(),
      });
      logger.warn(
        { mint: t.mintAddress, graduatedPoolAddress, progress },
        'migration-check: flipped token to graduated (webhook may have missed event)',
      );
    } catch (err) {
      logger.error({ err, mint: t.mintAddress }, 'migration-check: per-token error');
    }
  }
}

export async function startMigrationCheck(): Promise<Worker> {
  await migrationCheckQueue.add(
    'run',
    {},
    {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'migration-check:repeating',
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );
  const worker = new Worker(
    QUEUE_NAME,
    async (_job: Job) => {
      await checkGraduations();
    },
    { connection: makeConn(), concurrency: 1 },
  );
  worker.on('error', (err) => logger.error({ err }, 'migration-check worker error'));
  logger.info({ queue: QUEUE_NAME, everyMs: RUN_EVERY_MS }, 'migration-check started');
  return worker;
}
