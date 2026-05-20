import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../middleware/errorHandler.js';
import { buildSwapTx, getQuote, type Side } from '../lib/dbc.js';
import {
  confirmTx,
  connection,
  getLatestBlockhash,
  getPriorityFee,
  type PriorityFeeMode,
} from '../lib/solana.js';
import { syncTokenReservesFromChain } from './pool-sync.service.js';

export interface TradeQuoteInput {
  mint: string;
  side: Side;
  amount: bigint;
  slippageBps: number;
}

export interface TradeQuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  priceImpactBps: number;
  nextSqrtPrice: bigint;
}

async function resolvePoolByMint(mint: string): Promise<string> {
  const row = await prisma.token.findUnique({
    where: { mintAddress: mint },
    select: { poolAddress: true, isGraduated: true },
  });
  if (!row) throw new HttpError(404, `Token ${mint} not found`);
  if (row.isGraduated) {
    throw new HttpError(409, 'Token has graduated. Trade on the migrated AMM pool instead.');
  }
  return row.poolAddress;
}

/**
 * Compute a swap quote: expected output, minimum-out at slippage, and fees.
 * The price-impact is reported in basis points (1bps = 0.01%).
 */
export async function getTradeQuote(input: TradeQuoteInput): Promise<TradeQuoteResult> {
  if (input.amount <= 0n) throw new HttpError(400, 'amount must be > 0');
  if (input.slippageBps < 0 || input.slippageBps > 10_000) {
    throw new HttpError(400, 'slippageBps must be in [0, 10000]');
  }
  const poolAddress = await resolvePoolByMint(input.mint);
  const quote = await getQuote({
    poolAddress,
    amountIn: input.amount,
    side: input.side,
    slippageBps: input.slippageBps,
  });

  // Crude price-impact proxy: ratio of trading+protocol fee to amountIn, in bps.
  const feeBps =
    input.amount === 0n
      ? 0
      : Number(((quote.tradingFee + quote.protocolFee) * 10_000n) / input.amount);

  return {
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minimumAmountOut: quote.minimumAmountOut,
    tradingFee: quote.tradingFee,
    protocolFee: quote.protocolFee,
    priceImpactBps: feeBps,
    nextSqrtPrice: quote.nextSqrtPrice,
  };
}

export interface BuildSwapInput {
  mint: string;
  user: string;
  side: Side;
  amount: bigint;
  slippageBps: number;
  priorityFeeMode: PriorityFeeMode;
}

export interface BuildSwapResult {
  unsignedTx: string;
  blockhash: string;
  lastValidBlockHeight: number;
  quote: TradeQuoteResult;
}

/**
 * Build (without sending) an unsigned swap transaction for the user wallet to sign.
 * Returns the tx as base64 along with the blockhash needed to confirm it.
 */
/**
 * Anti-sniper guard: for the first N seconds after a token launches, cap
 * individual buys at M lamports. Configurable via env; defaults to 60s / 1 SOL.
 */
const SNIPER_GUARD_WINDOW_MS =
  Number(process.env.SNIPER_GUARD_WINDOW_SECONDS ?? '60') * 1000;
const SNIPER_GUARD_MAX_BUY_LAMPORTS = BigInt(
  process.env.SNIPER_GUARD_MAX_BUY_LAMPORTS ?? '1000000000', // 1 SOL
);

export async function buildSwapTransaction(input: BuildSwapInput): Promise<BuildSwapResult> {
  let userKey: PublicKey;
  try {
    userKey = new PublicKey(input.user);
  } catch {
    throw new HttpError(400, 'user must be a valid base58 pubkey');
  }
  const poolAddress = await resolvePoolByMint(input.mint);

  // Sniper guard — look up the token to check its age.
  if (input.side === 'buy') {
    const token = await prisma.token.findUnique({
      where: { mintAddress: input.mint },
      select: { createdAt: true },
    });
    if (token) {
      const ageMs = Date.now() - token.createdAt.getTime();
      if (ageMs < SNIPER_GUARD_WINDOW_MS && input.amount > SNIPER_GUARD_MAX_BUY_LAMPORTS) {
        const seconds = Math.ceil((SNIPER_GUARD_WINDOW_MS - ageMs) / 1000);
        throw new HttpError(
          429,
          `Anti-sniper: max ${SNIPER_GUARD_MAX_BUY_LAMPORTS / 1_000_000_000n} SOL per buy for the first 60s. Try again in ${seconds}s or buy less.`,
        );
      }
    }
  }

  const quote = await getTradeQuote({
    mint: input.mint,
    side: input.side,
    amount: input.amount,
    slippageBps: input.slippageBps,
  });

  const [priorityFee, blockhash] = await Promise.all([
    getPriorityFee(input.priorityFeeMode),
    getLatestBlockhash(),
  ]);

  const tx = await buildSwapTx({
    poolAddress,
    user: userKey,
    amountIn: quote.amountIn,
    minAmountOut: quote.minimumAmountOut,
    side: input.side,
    priorityFeeMicroLamports: priorityFee,
    blockhash,
  });

  return {
    unsignedTx: Buffer.from(tx.serialize()).toString('base64'),
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    quote,
  };
}

export interface SubmitSignedSwapInput {
  signedTx: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** When provided, pool reserves are synced from chain after confirmation. */
  mint?: string;
}

/**
 * Forward a user-signed swap tx to the cluster and wait for confirmation.
 * @returns The confirmed signature.
 */
export async function submitSignedSwap(input: SubmitSignedSwapInput): Promise<string> {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(input.signedTx, 'base64'));
  } catch {
    throw new HttpError(400, 'signedTx is not a valid base64 VersionedTransaction');
  }

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (err) {
    logger.error({ err }, 'sendRawTransaction failed');
    throw new HttpError(502, 'Failed to send transaction');
  }

  try {
    await confirmTx(signature, input.blockhash, input.lastValidBlockHeight);
  } catch (err) {
    throw new HttpError(502, `Transaction failed to confirm: ${(err as Error).message}`);
  }

  if (input.mint) {
    try {
      await syncTokenReservesFromChain(input.mint);
    } catch (err) {
      logger.warn({ err, mint: input.mint, signature }, 'post-swap reserve sync failed');
    }
  }

  return signature;
}
