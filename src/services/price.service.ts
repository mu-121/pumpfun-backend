import { Decimal } from 'decimal.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_PRICE_URL = `https://lite-api.jup.ag/price/v2?ids=${SOL_MINT}`;
const SOL_PRICE_REDIS_KEY = 'price:sol-usd';
const SOL_PRICE_TTL_SECONDS = 30;
const SOL_PRICE_FALLBACK = 150;

/**
 * Fetch the current SOL/USD price. Cached in Redis for 30s; falls back to
 * the last cached value (no TTL guard) or to a hard-coded constant on failure.
 */
export async function getSolPriceUsd(): Promise<number> {
  const cached = await redis.get(SOL_PRICE_REDIS_KEY);
  if (cached) {
    const n = Number(cached);
    if (Number.isFinite(n) && n > 0) return n;
  }

  try {
    const res = await fetch(JUP_PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: Record<string, { price?: string | number }>;
    };
    const raw = json.data?.[SOL_MINT]?.price;
    const price = typeof raw === 'string' ? Number(raw) : raw;
    if (!Number.isFinite(price) || (price as number) <= 0) {
      throw new Error(`bad price payload: ${JSON.stringify(json).slice(0, 200)}`);
    }
    await redis.set(SOL_PRICE_REDIS_KEY, String(price), 'EX', SOL_PRICE_TTL_SECONDS);
    return price as number;
  } catch (err) {
    logger.warn({ err }, 'getSolPriceUsd failed, using fallback');
    return SOL_PRICE_FALLBACK;
  }
}

export interface PriceFromReservesInput {
  /** Quote-token reserves in raw lamports (SOL has 9 decimals). */
  quoteReserveLamports: bigint;
  /** Base-token reserves in raw units (token has `baseDecimals` decimals). */
  baseReserveRaw: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}

/**
 * Compute price (quote per 1 unit of base) from on-chain reserves, decimal-aware.
 * Returns a Decimal to preserve precision; cast to Number at the boundary.
 */
/**
 * Compute a token's USD price from its on-chain reserves and a SOL/USD anchor.
 * Returns `{ priceSol, priceUsd }` as Decimals; cast at the boundary.
 */
export async function getTokenPriceUsd(input: PriceFromReservesInput): Promise<{
  priceSol: Decimal;
  priceUsd: Decimal;
}> {
  const priceSol = priceFromReserves(input);
  const solUsd = await getSolPriceUsd();
  return { priceSol, priceUsd: priceSol.mul(solUsd) };
}

export function priceFromReserves(input: PriceFromReservesInput): Decimal {
  if (input.baseReserveRaw === 0n) return new Decimal(0);
  const quote = new Decimal(input.quoteReserveLamports.toString()).div(
    new Decimal(10).pow(input.quoteDecimals),
  );
  const base = new Decimal(input.baseReserveRaw.toString()).div(
    new Decimal(10).pow(input.baseDecimals),
  );
  return quote.div(base);
}
