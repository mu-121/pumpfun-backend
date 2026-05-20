import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getPoolState } from '../lib/dbc.js';
import { publish } from '../lib/redis.js';
import { Channels } from '../lib/ws.js';
import { getSolPriceUsd, priceFromReserves } from './price.service.js';
import { Decimal } from 'decimal.js';

const TOKEN_DECIMALS = 6;
const QUOTE_DECIMALS = 9;

/**
 * Pull live DBC pool reserves from chain and persist them on the Token row.
 * Also publishes a `tokenState` WS event so open clients update immediately.
 */
export async function syncTokenReservesFromChain(mintAddress: string): Promise<void> {
  const token = await prisma.token.findUnique({ where: { mintAddress } });
  if (!token || token.isGraduated) return;

  const pool = await getPoolState(token.poolAddress);
  const quoteReserve = pool.quoteReserve;
  const baseReserve = pool.baseReserve;

  const priceSol = priceFromReserves({
    quoteReserveLamports: quoteReserve,
    baseReserveRaw: baseReserve,
    baseDecimals: TOKEN_DECIMALS,
    quoteDecimals: QUOTE_DECIMALS,
  });
  const solUsd = await getSolPriceUsd();
  const priceUsd = priceSol.mul(solUsd);
  const totalSupplyDec = new Decimal(token.totalSupply.toString()).div(
    new Decimal(10).pow(TOKEN_DECIMALS),
  );
  const marketCapUsd = priceUsd.mul(totalSupplyDec);

  await prisma.token.update({
    where: { mintAddress },
    data: {
      virtualSolReserves: quoteReserve,
      virtualTokenReserves: baseReserve,
      marketCapUsd: marketCapUsd.toNumber(),
    },
  });

  await publish(Channels.tokenState(mintAddress), {
    mintAddress,
    virtualSolReserves: quoteReserve.toString(),
    virtualTokenReserves: baseReserve.toString(),
    priceSol: priceSol.toString(),
    priceUsd: priceUsd.toString(),
    marketCapUsd: marketCapUsd.toString(),
  });

  logger.debug({ mintAddress, quoteReserve: quoteReserve.toString() }, 'synced pool reserves from chain');
}
