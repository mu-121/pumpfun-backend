import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { env, corsOrigins } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { closePrisma } from './lib/prisma.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { healthRouter } from './routes/health.routes.js';
import { tokensRouter } from './routes/tokens.routes.js';
import { tradeRouter } from './routes/trade.routes.js';
import { webhooksRouter } from './routes/webhooks.routes.js';
import { candlesRouter } from './routes/candles.routes.js';
import { profileRouter } from './routes/profile.routes.js';
import { metricsRouter } from './routes/metrics.routes.js';
import { attachWebSocket } from './lib/ws.js';
import { startIndexerWorker } from './workers/indexer.js';
import { startAggregator } from './workers/aggregator.js';
import { startMigrationCheck } from './workers/migration-check.js';
import { runBackfill } from './workers/backfill.js';

const app = express();

app.set('trust proxy', 1); // we run behind Caddy/nginx in prod
app.disable('x-powered-by');
app.use(requestId);
app.use(compression());
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }),
);
// Webhook endpoints need a generous body limit (Helius batches can be large)
app.use(express.json({ limit: '4mb' }));

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Helius retries on failures, so don't rate-limit the webhook path itself.
    skip: (req) => req.path.startsWith('/api/v1/webhooks/'),
  }),
);

app.use(healthRouter);
app.use('/api/v1', metricsRouter); // GET /api/v1/metrics

app.get('/api/v1/ping', (_req: Request, res: Response) => {
  res.json({ pong: true, timestamp: new Date().toISOString() });
});

app.use('/api/v1/tokens', tokensRouter);
app.use('/api/v1/tokens', candlesRouter); // mounts GET /:mint/candles
app.use('/api/v1/trade', tradeRouter);
app.use('/api/v1/webhooks', webhooksRouter);
app.use('/api/v1/profile', profileRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const httpServer = createServer(app);
attachWebSocket(httpServer);

const indexerWorker = startIndexerWorker();
let aggregatorWorker: Awaited<ReturnType<typeof startAggregator>> | undefined;
let migrationWorker: Awaited<ReturnType<typeof startMigrationCheck>> | undefined;

httpServer.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, network: env.SOLANA_NETWORK, env: env.NODE_ENV },
    'server listening',
  );

  void (async () => {
    try {
      aggregatorWorker = await startAggregator();
    } catch (err) {
      logger.error({ err }, 'aggregator failed to start');
    }
    try {
      migrationWorker = await startMigrationCheck();
    } catch (err) {
      logger.error({ err }, 'migration-check failed to start');
    }
    try {
      await runBackfill();
    } catch (err) {
      logger.error({ err }, 'backfill failed');
    }
  })();
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');

  const forceTimeout = setTimeout(() => {
    logger.error('shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000);
  forceTimeout.unref();

  await new Promise<void>((resolve) => {
    httpServer.close((err) => {
      if (err) logger.error({ err }, 'error closing http server');
      resolve();
    });
  });

  await Promise.allSettled([
    indexerWorker.close(),
    aggregatorWorker?.close(),
    migrationWorker?.close(),
    closeRedis(),
    closePrisma(),
  ]);

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});
