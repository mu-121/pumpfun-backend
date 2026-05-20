import { Router } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { connection } from '../lib/solana.js';
import { logger } from '../lib/logger.js';

const PACKAGE_VERSION = process.env.npm_package_version ?? '0.1.0';
const startedAt = Date.now();

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: PACKAGE_VERSION,
    network: env.SOLANA_NETWORK,
  });
});

interface Check {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function timed(fn: () => Promise<unknown>): Promise<Check> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

healthRouter.get('/health/deep', async (_req, res) => {
  const [db, redisCheck, rpc] = await Promise.all([
    timed(() => prisma.$queryRaw`SELECT 1`),
    timed(() => redis.ping()),
    timed(() => connection.getSlot('confirmed')),
  ]);
  const status = db.ok && redisCheck.ok && rpc.ok ? 'ok' : 'degraded';
  const code = status === 'ok' ? 200 : 503;
  if (status !== 'ok') {
    logger.warn({ db, redis: redisCheck, rpc }, 'deep health check failing');
  }
  res.status(code).json({
    status,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: PACKAGE_VERSION,
    network: env.SOLANA_NETWORK,
    checks: { db, redis: redisCheck, rpc },
  });
});
