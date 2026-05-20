import {
  Connection,
  PublicKey,
  type Commitment,
  type TransactionSignature,
  type BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const COMMITMENT: Commitment = 'confirmed';

/**
 * Singleton Solana RPC connection pointed at the Helius RPC URL from env.
 * Uses 'confirmed' commitment.
 */
export const connection: Connection = new Connection(env.HELIUS_RPC_URL, {
  commitment: COMMITMENT,
});

export const DBC_PROGRAM_ID: PublicKey = new PublicKey(env.DBC_PROGRAM_ID);
/** Wrapped SOL mint — used as quote mint for SOL-denominated bonding curves. */
export const WSOL_MINT: PublicKey = new PublicKey('So11111111111111111111111111111111111111112');

const DEFAULT_PRIORITY_FEE_MICROLAMPORTS = 50_000n;

export type PriorityFeeMode = 'auto' | 'fast' | 'turbo';

/**
 * Fetch a priority fee estimate (in micro-lamports per compute unit) from Helius.
 * Falls back to a sane default on RPC failure.
 *
 * @param mode - Speed bucket. 'auto' uses Helius "Medium", 'fast' uses "High",
 *               'turbo' uses "VeryHigh".
 * @returns Priority fee in micro-lamports.
 */
export async function getPriorityFee(mode: PriorityFeeMode = 'auto'): Promise<bigint> {
  const priorityLevel = mode === 'turbo' ? 'VeryHigh' : mode === 'fast' ? 'High' : 'Medium';
  try {
    const res = await fetch(env.HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'pump-priority-fee',
        method: 'getPriorityFeeEstimate',
        params: [{ options: { priorityLevel, includeAllPriorityFeeLevels: false } }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: { priorityFeeEstimate?: number };
      error?: unknown;
    };
    if (json.error || typeof json.result?.priorityFeeEstimate !== 'number') {
      throw new Error(`bad response: ${JSON.stringify(json)}`);
    }
    return BigInt(Math.ceil(json.result.priorityFeeEstimate));
  } catch (err) {
    logger.warn({ err, mode }, 'getPriorityFee failed, using default');
    return DEFAULT_PRIORITY_FEE_MICROLAMPORTS;
  }
}

/**
 * Confirm a transaction signature against a captured blockhash/lastValidBlockHeight.
 * Throws if the transaction errors or expires.
 *
 * @param signature - Transaction signature returned by sendRawTransaction.
 * @param blockhash - The blockhash bound into the transaction.
 * @param lastValidBlockHeight - The blockheight at which the blockhash expires.
 */
export async function confirmTx(
  signature: TransactionSignature,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<void> {
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    COMMITMENT,
  );
  if (result.value.err) {
    throw new Error(`Transaction ${signature} failed: ${JSON.stringify(result.value.err)}`);
  }
}

/** Get the latest blockhash + lastValidBlockHeight bundle. */
export async function getLatestBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
  return connection.getLatestBlockhash(COMMITMENT);
}
