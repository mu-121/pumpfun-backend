import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry: Registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'pump_clone_' });

export const tokenCount: Counter<string> = new Counter({
  name: 'pump_clone_tokens_total',
  help: 'Total Token rows persisted (cumulative since boot)',
  registers: [registry],
});

export const tradeCount: Counter<string> = new Counter({
  name: 'pump_clone_trades_total',
  help: 'Total Trade rows persisted (cumulative since boot)',
  labelNames: ['side'] as const,
  registers: [registry],
});

export const graduationCount: Counter<string> = new Counter({
  name: 'pump_clone_graduations_total',
  help: 'Tokens that completed the bonding curve',
  registers: [registry],
});

export const wsConnectedClients: Gauge<string> = new Gauge({
  name: 'pump_clone_ws_connected_clients',
  help: 'Currently-connected Socket.io clients',
  registers: [registry],
});

export const webhookLagSeconds: Histogram<string> = new Histogram({
  name: 'pump_clone_webhook_processing_lag_seconds',
  help: 'Seconds between webhook receive and indexer processing of each tx',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
