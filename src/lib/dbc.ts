import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  type VirtualPool,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

// Anchor's IdlTypes generic doesn't always resolve into a usable struct shape
// for SDK consumers, so we redeclare the runtime fields we read off the quote.
interface SwapQuoteFields {
  actualInputAmount: BN;
  outputAmount: BN;
  nextSqrtPrice: BN;
  tradingFee: BN;
  protocolFee: BN;
  referralFee: BN;
  minimumAmountOut: BN;
}
import { connection, WSOL_MINT } from './solana.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/errorHandler.js';

/** Singleton Meteora DBC client. */
export const dbc: DynamicBondingCurveClient = DynamicBondingCurveClient.create(
  connection,
  'confirmed',
);

export type Side = 'buy' | 'sell';

export interface PoolStateSnapshot {
  poolAddress: string;
  baseMint: string;
  configKey: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  sqrtPrice: bigint;
  isMigrated: boolean;
  raw: VirtualPool;
}

/**
 * Fetch on-chain pool state for a given pool address.
 * @param poolAddress - Base58 pool pubkey.
 */
export async function getPoolState(poolAddress: string): Promise<PoolStateSnapshot> {
  const pool = await dbc.state.getPool(new PublicKey(poolAddress));
  if (!pool) throw new Error(`Pool ${poolAddress} not found`);
  return {
    poolAddress,
    baseMint: pool.baseMint.toBase58(),
    configKey: pool.config.toBase58(),
    baseReserve: BigInt(pool.baseReserve.toString()),
    quoteReserve: BigInt(pool.quoteReserve.toString()),
    sqrtPrice: BigInt(pool.sqrtPrice.toString()),
    isMigrated: pool.isMigrated !== 0,
    raw: pool,
  };
}

/** Fetch pool + its config in one round trip. */
export async function getPoolAndConfig(
  poolAddress: string,
): Promise<{ pool: VirtualPool; config: PoolConfig }> {
  const pool = await dbc.state.getPool(new PublicKey(poolAddress));
  if (!pool) throw new Error(`Pool ${poolAddress} not found`);
  const config = await dbc.state.getPoolConfig(pool.config);
  return { pool, config };
}

export interface QuoteParams {
  poolAddress: string;
  amountIn: bigint;
  side: Side;
  slippageBps: number;
}

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  minimumAmountOut: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
  nextSqrtPrice: bigint;
}

/**
 * Compute a swap quote against on-chain pool state.
 * @param amountIn - Input amount in raw units (lamports for SOL side, base units for token side).
 * @param side - 'buy' = pay SOL, receive base token. 'sell' = pay base token, receive SOL.
 * @param slippageBps - Slippage tolerance in basis points (100 = 1%).
 */
export async function getQuote(params: QuoteParams): Promise<QuoteResult> {
  const { pool, config } = await getPoolAndConfig(params.poolAddress);
  const swapBaseForQuote = params.side === 'sell';
  const slot = await connection.getSlot('confirmed');
  const currentPoint = new BN(slot);

  const result = dbc.pool.swapQuote({
    virtualPool: pool,
    config,
    swapBaseForQuote,
    amountIn: new BN(params.amountIn.toString()),
    slippageBps: params.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  }) as unknown as SwapQuoteFields;

  return {
    amountIn: BigInt(result.actualInputAmount.toString()),
    amountOut: BigInt(result.outputAmount.toString()),
    minimumAmountOut: BigInt(result.minimumAmountOut.toString()),
    tradingFee: BigInt(result.tradingFee.toString()),
    protocolFee: BigInt(result.protocolFee.toString()),
    referralFee: BigInt(result.referralFee.toString()),
    nextSqrtPrice: BigInt(result.nextSqrtPrice.toString()),
  };
}

export interface BuildCreatePoolParams {
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  configKey: PublicKey;
  baseMint: PublicKey;
  priorityFeeMicroLamports: bigint;
  blockhash: BlockhashWithExpiryBlockHeight;
}

/**
 * Build (but do not send) a create-pool transaction. The caller is expected to
 * partial-sign with the mint keypair, then forward to the user wallet for the
 * final signature.
 *
 * @returns A v0 VersionedTransaction with priority fee instructions prepended.
 */
export async function buildCreatePoolTx(
  params: BuildCreatePoolParams,
): Promise<VersionedTransaction> {
  let tx: Transaction;
  try {
    tx = await dbc.pool.createPool({
      name: params.name,
      symbol: params.symbol,
      uri: params.uri,
      payer: params.creator,
      poolCreator: params.creator,
      config: params.configKey,
      baseMint: params.baseMint,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Pool config not found')) {
      throw new HttpError(
        503,
        `DBC_CONFIG_KEY (${params.configKey.toBase58()}) is not deployed on ${env.SOLANA_NETWORK}. Run: npx tsx scripts/create-config-key.ts`,
      );
    }
    throw err;
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.priorityFeeMicroLamports,
    }),
    ...tx.instructions,
  ];

  const message = new TransactionMessage({
    payerKey: params.creator,
    recentBlockhash: params.blockhash.blockhash,
    instructions,
  }).compileToV0Message();

  return new VersionedTransaction(message);
}

export interface BuildSwapParams {
  poolAddress: string;
  user: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  side: Side;
  priorityFeeMicroLamports: bigint;
  blockhash: BlockhashWithExpiryBlockHeight;
}

/**
 * Build (but do not send) a swap transaction for a user wallet to sign.
 */
export async function buildSwapTx(params: BuildSwapParams): Promise<VersionedTransaction> {
  const tx: Transaction = await dbc.pool.swap({
    owner: params.user,
    pool: new PublicKey(params.poolAddress),
    amountIn: new BN(params.amountIn.toString()),
    minimumAmountOut: new BN(params.minAmountOut.toString()),
    swapBaseForQuote: params.side === 'sell',
    referralTokenAccount: null,
    payer: params.user,
  });

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: params.priorityFeeMicroLamports,
    }),
    ...tx.instructions,
  ];

  const message = new TransactionMessage({
    payerKey: params.user,
    recentBlockhash: params.blockhash.blockhash,
    instructions,
  }).compileToV0Message();

  return new VersionedTransaction(message);
}

/**
 * Derive the deterministic pool address for a {config, baseMint, quoteMint=WSOL} triple.
 */
export function derivePoolAddress(baseMint: PublicKey, configKey: PublicKey): PublicKey {
  return deriveDbcPoolAddress(WSOL_MINT, baseMint, configKey);
}

/**
 * Generate a fresh mint keypair for a new token launch.
 * The secret material never leaves the process; the caller is responsible for
 * partial-signing the create-pool tx with it before returning the tx to the client.
 */
export function generateMintKeypair(): Keypair {
  return Keypair.generate();
}

export function getConfigKey(): PublicKey {
  if (!env.DBC_CONFIG_KEY) {
    throw new Error(
      'DBC_CONFIG_KEY is not set. Run scripts/create-config-key.ts and copy the result into .env.',
    );
  }
  return new PublicKey(env.DBC_CONFIG_KEY);
}
