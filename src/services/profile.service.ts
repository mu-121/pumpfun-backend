import BigNumber from 'bignumber.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import type { Holder, Token, Trade } from '@prisma/client';

const CACHE_TTL_SECONDS = 30;
const TOKEN_DECIMALS = 6;

export interface ProfileHolding {
  token: Pick<Token, 'mintAddress' | 'name' | 'symbol' | 'imageUrl' | 'marketCapUsd' | 'isGraduated'>;
  balance: string;
  valueUsd: number;
}

export interface ProfilePayload {
  address: string;
  tokensCreated: Token[];
  recentTrades: Trade[];
  holdings: ProfileHolding[];
}

function cacheKey(address: string): string {
  return `profile:${address}`;
}

/**
 * Aggregate a wallet's launchpad activity:
 *   - tokens they created (most recent first)
 *   - their last 50 trades across all tokens
 *   - current SPL holdings (computed value = balance/totalSupply * marketCapUsd)
 *
 * Results are cached in Redis for 30 s per address. The cache is bypassed if
 * `fresh` is true.
 */
export async function getProfile(
  address: string,
  opts: { fresh?: boolean } = {},
): Promise<ProfilePayload> {
  if (!opts.fresh) {
    const cached = await redis.get(cacheKey(address));
    if (cached) {
      try {
        return JSON.parse(cached) as ProfilePayload;
      } catch (err) {
        logger.warn({ err, address }, 'profile cache parse failed; ignoring');
      }
    }
  }

  const [tokensCreated, recentTrades, holderRows] = await Promise.all([
    prisma.token.findMany({
      where: { creatorAddress: address },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.trade.findMany({
      where: { traderAddress: address },
      orderBy: { blockTime: 'desc' },
      take: 50,
    }),
    prisma.holder.findMany({
      where: { walletAddress: address, balance: { gt: 0 } },
      orderBy: { balance: 'desc' },
      take: 50,
      include: {
        token: {
          select: {
            mintAddress: true,
            name: true,
            symbol: true,
            imageUrl: true,
            marketCapUsd: true,
            isGraduated: true,
            totalSupply: true,
          },
        },
      },
    }),
  ]);

  const holdings: ProfileHolding[] = holderRows.map((row) => {
    // Value = (balance / totalSupply) * marketCapUsd. Both are raw token units;
    // the ratio is decimal-agnostic.
    const total = new BigNumber(row.token.totalSupply.toString());
    const value = total.isZero()
      ? 0
      : new BigNumber(row.balance.toString())
          .div(total)
          .times(row.token.marketCapUsd)
          .toNumber();
    void TOKEN_DECIMALS;
    return {
      token: {
        mintAddress: row.token.mintAddress,
        name: row.token.name,
        symbol: row.token.symbol,
        imageUrl: row.token.imageUrl,
        marketCapUsd: row.token.marketCapUsd,
        isGraduated: row.token.isGraduated,
      },
      balance: row.balance.toString(),
      valueUsd: value,
    };
  });

  const payload: ProfilePayload = {
    address,
    tokensCreated,
    recentTrades,
    holdings,
  };

  await redis.set(cacheKey(address), JSON.stringify(payload, bigintReplacer), 'EX', CACHE_TTL_SECONDS);
  return JSON.parse(JSON.stringify(payload, bigintReplacer)) as ProfilePayload;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
