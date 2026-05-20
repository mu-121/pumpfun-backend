import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ok } from '../lib/http.js';
import { HttpError } from '../middleware/errorHandler.js';
import { createGuards } from '../middleware/createGuards.js';
import { createTokenLaunch, submitSignedLaunch } from '../services/token.service.js';
import { syncTokenReservesFromChain } from '../services/pool-sync.service.js';
import { getPoolState } from '../lib/dbc.js';

export const tokensRouter: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

const createBodySchema = z.object({
  name: z.string().min(1).max(32),
  symbol: z.string().min(1).max(10),
  description: z.string().max(500).optional(),
  twitter: z.string().url().optional(),
  telegram: z.string().url().optional(),
  website: z.string().url().optional(),
  creatorAddress: z.string().min(32).max(44),
});

// Per-IP backstop on the create endpoint. Wallet-keyed rate-limiting and the
// minimum-balance check live in `createGuards` since they need the parsed body.
const createIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RateLimited', message: 'Too many create attempts from this IP. Slow down.' } },
});

tokensRouter.post(
  '/create',
  createIpLimiter,
  upload.single('image'),
  createGuards,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createBodySchema.parse(req.body);
      if (!req.file) throw new HttpError(400, 'image file is required');
      const result = await createTokenLaunch({
        creator: parsed.creatorAddress,
        name: parsed.name,
        symbol: parsed.symbol,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        imageBuffer: req.file.buffer,
        imageMime: req.file.mimetype,
        ...(parsed.twitter !== undefined ? { twitter: parsed.twitter } : {}),
        ...(parsed.telegram !== undefined ? { telegram: parsed.telegram } : {}),
        ...(parsed.website !== undefined ? { website: parsed.website } : {}),
      });
      ok(res, result, 201);
    } catch (err) {
      next(err);
    }
  },
);

const submitBodySchema = z.object({
  launchSessionId: z.string().uuid(),
  signedTx: z.string().min(1),
});

tokensRouter.post('/create/submit', async (req, res, next) => {
  try {
    const parsed = submitBodySchema.parse(req.body);
    const result = await submitSignedLaunch(parsed);
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  sort: z.enum(['new', 'trending', 'graduating', 'graduated']).default('new'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  search: z.string().min(1).max(64).optional(),
});

tokensRouter.get('/', async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const where: Prisma.TokenWhereInput = {};
    if (q.sort === 'graduated') where.isGraduated = true;
    else if (q.sort === 'graduating') where.isGraduated = false;
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { symbol: { contains: q.search, mode: 'insensitive' } },
        { mintAddress: { equals: q.search } },
      ];
    }

    let orderBy: Prisma.TokenOrderByWithRelationInput;
    let cursorField: 'createdAt' | 'lastTradeAt' | 'marketCapUsd' = 'createdAt';
    if (q.sort === 'new') {
      orderBy = { createdAt: 'desc' };
      cursorField = 'createdAt';
    } else if (q.sort === 'trending') {
      orderBy = { lastTradeAt: 'desc' };
      cursorField = 'lastTradeAt';
    } else if (q.sort === 'graduating') {
      orderBy = { marketCapUsd: 'desc' };
      cursorField = 'marketCapUsd';
    } else {
      orderBy = { graduatedAt: 'desc' };
      cursorField = 'createdAt';
    }

    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (cursorField === 'marketCapUsd') {
        where[cursorField] = { lt: Number(decoded) };
      } else {
        where[cursorField] = { lt: new Date(decoded) };
      }
    }

    const rows = await prisma.token.findMany({ where, orderBy, take: q.limit + 1 });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    let nextCursor: string | undefined;
    if (hasMore && last) {
      if (cursorField === 'marketCapUsd') nextCursor = encodeCursor(String(last.marketCapUsd));
      else if (cursorField === 'lastTradeAt' && last.lastTradeAt)
        nextCursor = encodeCursor(last.lastTradeAt.toISOString());
      else nextCursor = encodeCursor(last.createdAt.toISOString());
    }
    ok(res, { items, nextCursor: nextCursor ?? null });
  } catch (err) {
    next(err);
  }
});

tokensRouter.get('/:mint', async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!mint) throw new HttpError(400, 'mint is required');
    const row = await prisma.token.findUnique({ where: { mintAddress: mint } });
    if (!row) throw new HttpError(404, 'Token not found');
    let onChain: Awaited<ReturnType<typeof getPoolState>> | null = null;
    if (!row.isGraduated) {
      try {
        onChain = await getPoolState(row.poolAddress);
      } catch (err) {
        // If chain fetch fails, return DB row alone; don't 500 the whole request.
        onChain = null;
      }
    }
    let virtualSolReserves = row.virtualSolReserves;
    let virtualTokenReserves = row.virtualTokenReserves;
    if (onChain && !row.isGraduated) {
      virtualSolReserves = onChain.quoteReserve;
      virtualTokenReserves = onChain.baseReserve;
      if (row.virtualSolReserves === 0n && onChain.quoteReserve > 0n) {
        void syncTokenReservesFromChain(mint).catch(() => undefined);
      }
    }

    ok(res, {
      ...row,
      virtualSolReserves,
      virtualTokenReserves,
      onChain: onChain
        ? {
            baseReserve: onChain.baseReserve.toString(),
            quoteReserve: onChain.quoteReserve.toString(),
            sqrtPrice: onChain.sqrtPrice.toString(),
            isMigrated: onChain.isMigrated,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

tokensRouter.get('/:mint/holders', async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!mint) throw new HttpError(400, 'mint is required');
    const { limit, cursor } = paginationSchema.parse(req.query);
    const where: Prisma.HolderWhereInput = { tokenMint: mint };
    if (cursor) {
      const decoded = decodeCursor(cursor);
      where.balance = { lt: BigInt(decoded) };
    }
    const rows = await prisma.holder.findMany({
      where,
      orderBy: { balance: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    const nextCursor = hasMore && last ? encodeCursor(last.balance.toString()) : null;
    ok(res, { items, nextCursor });
  } catch (err) {
    next(err);
  }
});

tokensRouter.get('/:mint/trades', async (req, res, next) => {
  try {
    const mint = req.params.mint;
    if (!mint) throw new HttpError(400, 'mint is required');
    const { limit, cursor } = paginationSchema.parse(req.query);
    const where: Prisma.TradeWhereInput = { tokenMint: mint };
    if (cursor) {
      where.blockTime = { lt: new Date(decodeCursor(cursor)) };
    }
    const rows = await prisma.trade.findMany({
      where,
      orderBy: { blockTime: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    const nextCursor = hasMore && last ? encodeCursor(last.blockTime.toISOString()) : null;
    ok(res, { items, nextCursor });
  } catch (err) {
    next(err);
  }
});

function encodeCursor(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function decodeCursor(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}
