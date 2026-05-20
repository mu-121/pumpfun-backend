import { PublicKey } from '@solana/web3.js';
import { Prisma, TradeSide } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { connection, WSOL_MINT } from '../lib/solana.js';
import { publish } from '../lib/redis.js';
import { Channels } from '../lib/ws.js';
import { dbc } from '../lib/dbc.js';
import { graduationCount, tokenCount, tradeCount } from '../lib/metrics.js';
import { getSolPriceUsd, priceFromReserves } from './price.service.js';

const TOKEN_DECIMALS = 6;
const QUOTE_DECIMALS = 9; // SOL

/** Anchor `tradeDirection`: 0 = BaseToQuote (sell), 1 = QuoteToBase (buy). */
function directionToSide(direction: number | bigint): TradeSide {
  return Number(direction) === 1 ? TradeSide.BUY : TradeSide.SELL;
}

/** Payload shape for an `evtSwap` / `evtSwap2` event after Borsh decoding. */
export interface DecodedSwap {
  pool: PublicKey;
  config: PublicKey;
  tradeDirection: number;
  amountIn: bigint;
  outputAmount: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  currentTimestamp: bigint;
}

export interface DecodedInitializePool {
  pool: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
}

export interface DecodedCurveComplete {
  pool: PublicKey;
  config: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
}

export interface EventContext {
  signature: string;
  slot: bigint;
  blockTime: Date;
  trader?: string;
}

/**
 * Handle an evtInitializePool event. If we don't yet have a Token row (the
 * pool was created outside our API), insert a minimal placeholder so trades
 * downstream don't drop on the floor.
 */
export async function handleInitializePool(
  evt: DecodedInitializePool,
  _ctx: EventContext,
): Promise<void> {
  const mintAddress = evt.baseMint.toBase58();
  const existing = await prisma.token.findUnique({ where: { mintAddress } });
  if (existing) return;

  await prisma.token.create({
    data: {
      mintAddress,
      poolAddress: evt.pool.toBase58(),
      configKey: evt.config.toBase58(),
      creatorAddress: evt.creator.toBase58(),
      name: '',
      symbol: '',
      totalSupply: 0n,
    },
  });
  tokenCount.inc();
  logger.info({ mintAddress }, 'indexer: inserted placeholder Token from on-chain event');
  await publish(Channels.newToken, {
    mintAddress,
    poolAddress: evt.pool.toBase58(),
    creatorAddress: evt.creator.toBase58(),
  });
}

/**
 * Handle an `evtSwap` / `evtSwap2` event:
 *   - upsert the Trade row (signature unique = idempotent)
 *   - update Token reserves / lastTradeAt / tradeCount / marketCapUsd
 *   - upsert the trader's Holder balance (refetched from chain)
 *   - publish to Redis for the WS layer to broadcast
 */
export async function handleSwap(evt: DecodedSwap, ctx: EventContext): Promise<void> {
  const poolAddress = evt.pool.toBase58();
  const token = await prisma.token.findUnique({ where: { poolAddress } });
  if (!token) {
    logger.warn({ poolAddress, signature: ctx.signature }, 'swap for unknown pool, skipping');
    return;
  }

  // Idempotency: signature is unique on Trade
  const existing = await prisma.trade.findUnique({
    where: { signature: ctx.signature },
    select: { id: true },
  });
  if (existing) return;

  const side = directionToSide(evt.tradeDirection);
  // BUY: amountIn = SOL (quote), outputAmount = tokens (base)
  // SELL: amountIn = tokens (base), outputAmount = SOL (quote)
  const solAmount = side === TradeSide.BUY ? evt.amountIn : evt.outputAmount;
  const tokenAmount = side === TradeSide.BUY ? evt.outputAmount : evt.amountIn;

  // Pull fresh pool state to compute price and update reserves.
  let baseReserve = 0n;
  let quoteReserve = 0n;
  try {
    const pool = await dbc.state.getPool(evt.pool);
    if (pool) {
      baseReserve = BigInt(pool.baseReserve.toString());
      quoteReserve = BigInt(pool.quoteReserve.toString());
    }
  } catch (err) {
    logger.warn({ err, poolAddress }, 'failed to refetch pool state; using event-only data');
  }

  const priceSol = priceFromReserves({
    quoteReserveLamports: quoteReserve,
    baseReserveRaw: baseReserve,
    baseDecimals: TOKEN_DECIMALS,
    quoteDecimals: QUOTE_DECIMALS,
  });
  const solUsd = await getSolPriceUsd();
  const priceUsd = priceSol.mul(solUsd);

  // Market cap = priceUsd * circulating supply. We don't track circulating
  // separately yet; total supply is fixed at 1B for our launch config.
  const totalSupplyDec = new Decimal(token.totalSupply.toString()).div(
    new Decimal(10).pow(TOKEN_DECIMALS),
  );
  const marketCapUsd = priceUsd.mul(totalSupplyDec);

  await prisma.$transaction(async (tx) => {
    await tx.trade.create({
      data: {
        signature: ctx.signature,
        tokenMint: token.mintAddress,
        traderAddress: ctx.trader ?? 'unknown',
        side,
        solAmount,
        tokenAmount,
        priceSol: priceSol.toNumber(),
        priceUsd: priceUsd.toNumber(),
        slot: ctx.slot,
        blockTime: ctx.blockTime,
      },
    });
    await tx.token.update({
      where: { mintAddress: token.mintAddress },
      data: {
        virtualSolReserves: quoteReserve,
        virtualTokenReserves: baseReserve,
        lastTradeAt: ctx.blockTime,
        tradeCount: { increment: 1 },
        marketCapUsd: marketCapUsd.toNumber(),
      },
    });
  });

  if (ctx.trader) {
    void refreshHolderBalance(token.mintAddress, ctx.trader).catch((err) =>
      logger.warn({ err, trader: ctx.trader }, 'holder refresh failed'),
    );
  }

  const payload = {
    signature: ctx.signature,
    mintAddress: token.mintAddress,
    side,
    solAmount: solAmount.toString(),
    tokenAmount: tokenAmount.toString(),
    priceSol: priceSol.toString(),
    priceUsd: priceUsd.toString(),
    marketCapUsd: marketCapUsd.toString(),
    blockTime: ctx.blockTime.toISOString(),
    trader: ctx.trader,
  };
  await publish(Channels.trade(token.mintAddress), payload);
  await publish(Channels.tokenState(token.mintAddress), {
    mintAddress: token.mintAddress,
    virtualSolReserves: quoteReserve.toString(),
    virtualTokenReserves: baseReserve.toString(),
    priceSol: priceSol.toString(),
    priceUsd: priceUsd.toString(),
    marketCapUsd: marketCapUsd.toString(),
  });

  tradeCount.inc({ side });
  logger.info(
    {
      mint: token.mintAddress,
      sig: ctx.signature,
      side,
      solAmount: solAmount.toString(),
      tokenAmount: tokenAmount.toString(),
    },
    'indexer: trade processed',
  );
}

/**
 * Handle an evtCurveComplete event — bonding curve has filled; the token is
 * about to migrate (or has just migrated) to a DAMM v2 pool.
 */
export async function handleCurveComplete(
  evt: DecodedCurveComplete,
  ctx: EventContext,
): Promise<void> {
  const poolAddress = evt.pool.toBase58();
  const token = await prisma.token.findUnique({ where: { poolAddress } });
  if (!token) {
    logger.warn({ poolAddress, signature: ctx.signature }, 'curveComplete for unknown pool');
    return;
  }
  if (token.isGraduated) return; // idempotent

  // Derive the DAMM v2 pool the curve migrates into. The DBC config doubles
  // as the DAMM v2 config (Meteora reuses the same account model).
  const graduatedPoolAddress = deriveDammV2PoolAddress(
    evt.config,
    new PublicKey(token.mintAddress),
    WSOL_MINT,
  ).toBase58();

  await prisma.token.update({
    where: { mintAddress: token.mintAddress },
    data: {
      isGraduated: true,
      graduatedAt: ctx.blockTime,
      graduatedPoolAddress,
    },
  });
  await publish(Channels.graduation(token.mintAddress), {
    mintAddress: token.mintAddress,
    poolAddress,
    graduatedPoolAddress,
    signature: ctx.signature,
    blockTime: ctx.blockTime.toISOString(),
  });
  graduationCount.inc();
  logger.info(
    { mint: token.mintAddress, sig: ctx.signature, graduatedPoolAddress },
    'indexer: token graduated',
  );
}

async function refreshHolderBalance(mintAddress: string, walletAddress: string): Promise<void> {
  let wallet: PublicKey;
  let mint: PublicKey;
  try {
    wallet = new PublicKey(walletAddress);
    mint = new PublicKey(mintAddress);
  } catch {
    return;
  }
  const accounts = await connection.getParsedTokenAccountsByOwner(
    wallet,
    { mint },
    'confirmed',
  );
  let total = 0n;
  for (const { account } of accounts.value) {
    const parsed = account.data as Prisma.JsonValue;
    if (typeof parsed === 'object' && parsed !== null && 'parsed' in parsed) {
      const p = (parsed as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed;
      const raw = p?.info?.tokenAmount?.amount;
      if (typeof raw === 'string') total += BigInt(raw);
    }
  }
  await prisma.holder.upsert({
    where: { tokenMint_walletAddress: { tokenMint: mintAddress, walletAddress } },
    update: { balance: total },
    create: { tokenMint: mintAddress, walletAddress, balance: total },
  });
}
