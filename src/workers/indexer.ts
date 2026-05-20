import { PublicKey } from '@solana/web3.js';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import {
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  handleCurveComplete,
  handleInitializePool,
  handleSwap,
  type DecodedCurveComplete,
  type DecodedInitializePool,
  type DecodedSwap,
  type EventContext,
} from '../services/indexer.service.js';

const PROGRAM_DATA_PREFIX = 'Program data: ';
const QUEUE_NAME = 'indexer';

const coder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl);

/** Minimal shape of one entry in a Helius webhook payload (raw or enhanced). */
export interface HeliusTxLike {
  signature?: string;
  slot?: number;
  timestamp?: number;
  feePayer?: string;
  meta?: { logMessages?: string[] | null } | null;
  transaction?: {
    message?: { accountKeys?: Array<string | { pubkey: string }> | null } | null;
    signatures?: string[] | null;
  } | null;
}

export const indexerQueue: Queue = new Queue(QUEUE_NAME, {
  connection: makeBullConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 500 },
  },
});

function makeBullConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * Enqueue a Helius webhook batch for async processing.
 * Returns immediately — the request handler should respond 200 right away.
 */
export async function enqueueWebhookBatch(payload: HeliusTxLike[]): Promise<void> {
  if (!Array.isArray(payload) || payload.length === 0) return;
  await indexerQueue.add('webhook-batch', { txs: payload }, { jobId: undefined });
}

/**
 * Start the BullMQ worker that processes Helius webhook batches and any
 * backfill jobs that get enqueued.
 */
export function startIndexerWorker(): Worker {
  const worker = new Worker<{ txs: HeliusTxLike[] }>(
    QUEUE_NAME,
    async (job: Job<{ txs: HeliusTxLike[] }>) => {
      const txs = job.data.txs;
      for (const tx of txs) {
        try {
          await processTransaction(tx);
        } catch (err) {
          // Never let a single bad tx kill the worker — log and continue.
          logger.error({ err, signature: tx.signature }, 'indexer: processTransaction failed');
        }
      }
    },
    {
      connection: makeBullConnection(),
      concurrency: 4,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'indexer worker job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err }, 'indexer worker error');
  });
  logger.info({ queue: QUEUE_NAME }, 'indexer worker started');
  return worker;
}

/**
 * Decode every `Program data: ...` log line for known DBC events and dispatch
 * each one to the right handler. Idempotent: handlers no-op on duplicates.
 */
export async function processTransaction(tx: HeliusTxLike): Promise<void> {
  const signature = tx.signature ?? tx.transaction?.signatures?.[0];
  if (!signature) {
    logger.debug('skipping tx with no signature');
    return;
  }
  const logs = tx.meta?.logMessages ?? [];
  if (logs.length === 0) return;

  const slot = tx.slot ? BigInt(tx.slot) : 0n;
  const blockTime = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();
  const trader = extractFeePayer(tx);
  const ctx: EventContext = { signature, slot, blockTime, ...(trader ? { trader } : {}) };

  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const data = line.slice(PROGRAM_DATA_PREFIX.length);
    let decoded: { name: string; data: unknown } | null = null;
    try {
      decoded = coder.events.decode(data);
    } catch {
      continue; // not an event we recognize, or malformed
    }
    if (!decoded) continue;

    try {
      await dispatchEvent(decoded.name, decoded.data, ctx);
    } catch (err) {
      logger.error(
        { err, event: decoded.name, signature, ctx_slot: ctx.slot.toString() },
        'indexer: event handler threw',
      );
    }
  }
}

async function dispatchEvent(
  name: string,
  data: unknown,
  ctx: EventContext,
): Promise<void> {
  switch (name) {
    case 'evtInitializePool': {
      await handleInitializePool(toInitializePool(data), ctx);
      return;
    }
    case 'evtSwap':
    case 'evtSwap2': {
      await handleSwap(toSwap(data, name === 'evtSwap2'), ctx);
      return;
    }
    case 'evtCurveComplete': {
      await handleCurveComplete(toCurveComplete(data), ctx);
      return;
    }
    default:
      logger.debug({ name }, 'indexer: ignoring unhandled event');
  }
}

function extractFeePayer(tx: HeliusTxLike): string | undefined {
  if (typeof tx.feePayer === 'string') return tx.feePayer;
  const keys = tx.transaction?.message?.accountKeys;
  if (!keys || keys.length === 0) return undefined;
  const first = keys[0];
  if (!first) return undefined;
  return typeof first === 'string' ? first : first.pubkey;
}

function bnToBigInt(v: unknown): bigint {
  if (v instanceof BN) return BigInt(v.toString());
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v);
  return 0n;
}

function pk(v: unknown): PublicKey {
  if (v instanceof PublicKey) return v;
  if (typeof v === 'string') return new PublicKey(v);
  throw new Error('expected PublicKey');
}

function toInitializePool(raw: unknown): DecodedInitializePool {
  const o = raw as Record<string, unknown>;
  return {
    pool: pk(o.pool),
    config: pk(o.config),
    creator: pk(o.creator),
    baseMint: pk(o.baseMint),
  };
}

function toSwap(raw: unknown, isV2: boolean): DecodedSwap {
  const o = raw as Record<string, unknown>;
  // evtSwap & evtSwap2 use different inner shapes for swap params/result, but
  // both have top-level `tradeDirection`, `currentTimestamp`, and a
  // `swapResult` defined block with `outputAmount`, `tradingFee`, `protocolFee`.
  const result = (o.swapResult ?? {}) as Record<string, unknown>;
  // evtSwap exposes amountIn at the top level; evtSwap2 puts the input amount
  // inside `swapResult.includedFeeInputAmount` (or `excludedFeeInputAmount`).
  let amountIn: bigint;
  if (isV2) {
    amountIn =
      bnToBigInt(result.includedFeeInputAmount) || bnToBigInt(result.excludedFeeInputAmount);
  } else {
    amountIn = bnToBigInt(o.amountIn);
  }
  return {
    pool: pk(o.pool),
    config: pk(o.config),
    tradeDirection: Number(o.tradeDirection ?? 0),
    amountIn,
    outputAmount: bnToBigInt(result.outputAmount),
    tradingFee: bnToBigInt(result.tradingFee),
    protocolFee: bnToBigInt(result.protocolFee),
    currentTimestamp: bnToBigInt(o.currentTimestamp),
  };
}

function toCurveComplete(raw: unknown): DecodedCurveComplete {
  const o = raw as Record<string, unknown>;
  return {
    pool: pk(o.pool),
    config: pk(o.config),
    baseReserve: bnToBigInt(o.baseReserve),
    quoteReserve: bnToBigInt(o.quoteReserve),
  };
}
