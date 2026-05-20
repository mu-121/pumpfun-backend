import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { connection } from '../lib/solana.js';
import { enqueueWebhookBatch, processTransaction, type HeliusTxLike } from './indexer.js';

const MAX_SIGS_PER_POOL = 200;
const MAX_AGE_MS_ON_FIRST_RUN = 24 * 60 * 60 * 1000;

/**
 * On boot, walk recent signatures for every pool we know about and feed any
 * tx we haven't seen yet through the indexer. Caps at 200 signatures/pool and
 * 24h of history on the very first run.
 */
export async function runBackfill(): Promise<void> {
  const tokens = await prisma.token.findMany({
    where: { isGraduated: false },
    select: { mintAddress: true, poolAddress: true },
  });
  if (tokens.length === 0) {
    logger.info('backfill: no tokens to scan');
    return;
  }
  logger.info({ count: tokens.length }, 'backfill: starting');

  const cutoffSec = Math.floor((Date.now() - MAX_AGE_MS_ON_FIRST_RUN) / 1000);

  let totalEnqueued = 0;
  for (const t of tokens) {
    try {
      const newest = await prisma.trade.findFirst({
        where: { tokenMint: t.mintAddress },
        orderBy: { blockTime: 'desc' },
        select: { signature: true },
      });

      const opts: { limit: number; until?: string } = { limit: MAX_SIGS_PER_POOL };
      if (newest?.signature) opts.until = newest.signature;
      const sigs = await connection.getSignaturesForAddress(new PublicKey(t.poolAddress), opts);

      const fresh = sigs.filter(
        (s) => !s.err && (!s.blockTime || s.blockTime >= cutoffSec),
      );
      if (fresh.length === 0) continue;

      // Process oldest-first so handler-side state evolves correctly.
      fresh.reverse();
      const batch: HeliusTxLike[] = [];
      for (const s of fresh) {
        const tx = await connection.getTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx) continue;
        const accountKeys = tx.transaction.message
          .getAccountKeys()
          .keySegments()
          .flat()
          .map((k) => k.toBase58());
        batch.push({
          signature: s.signature,
          slot: tx.slot,
          ...(tx.blockTime != null ? { timestamp: tx.blockTime } : {}),
          ...(accountKeys[0] !== undefined ? { feePayer: accountKeys[0] } : {}),
          meta: { logMessages: tx.meta?.logMessages ?? [] },
          transaction: { message: { accountKeys }, signatures: [s.signature] },
        });
      }
      if (batch.length === 0) continue;
      // Process inline (already on a startup tick) rather than enqueueing to BullMQ
      // to keep the boot path observable; switch to enqueue if pools get large.
      for (const tx of batch) {
        try {
          await processTransaction(tx);
        } catch (err) {
          logger.error({ err, sig: tx.signature }, 'backfill: tx failed');
        }
      }
      totalEnqueued += batch.length;
    } catch (err) {
      logger.error({ err, mint: t.mintAddress }, 'backfill: pool failed');
    }
  }

  logger.info({ totalEnqueued }, 'backfill: complete');
}

/** Convenience wrapper for callers that prefer the queue path. */
export async function enqueueBackfillBatch(txs: HeliusTxLike[]): Promise<void> {
  await enqueueWebhookBatch(txs);
}
