import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../lib/http.js';
import {
  buildSwapTransaction,
  getTradeQuote,
  submitSignedSwap,
} from '../services/trade.service.js';

export const tradeRouter: Router = Router();

const bigintString = z.string().regex(/^[0-9]+$/);

const quoteSchema = z.object({
  mint: z.string().min(32).max(44),
  side: z.enum(['buy', 'sell']),
  amount: bigintString,
  slippageBps: z.number().int().min(0).max(10_000).default(100),
});

tradeRouter.post('/quote', async (req, res, next) => {
  try {
    const parsed = quoteSchema.parse(req.body);
    const result = await getTradeQuote({
      mint: parsed.mint,
      side: parsed.side,
      amount: BigInt(parsed.amount),
      slippageBps: parsed.slippageBps,
    });
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

const buildSchema = z.object({
  mint: z.string().min(32).max(44),
  side: z.enum(['buy', 'sell']),
  amount: bigintString,
  slippageBps: z.number().int().min(0).max(10_000).default(100),
  user: z.string().min(32).max(44),
  priorityFeeMode: z.enum(['auto', 'fast', 'turbo']).default('auto'),
});

tradeRouter.post('/build', async (req, res, next) => {
  try {
    const parsed = buildSchema.parse(req.body);
    const result = await buildSwapTransaction({
      mint: parsed.mint,
      side: parsed.side,
      amount: BigInt(parsed.amount),
      slippageBps: parsed.slippageBps,
      user: parsed.user,
      priorityFeeMode: parsed.priorityFeeMode,
    });
    ok(res, result);
  } catch (err) {
    next(err);
  }
});

const submitSchema = z.object({
  signedTx: z.string().min(1),
  blockhash: z.string().min(1),
  lastValidBlockHeight: z.number().int().positive(),
  mint: z.string().min(32).max(44).optional(),
});

tradeRouter.post('/submit', async (req, res, next) => {
  try {
    const parsed = submitSchema.parse(req.body);
    const signature = await submitSignedSwap({
      signedTx: parsed.signedTx,
      blockhash: parsed.blockhash,
      lastValidBlockHeight: parsed.lastValidBlockHeight,
      ...(parsed.mint !== undefined ? { mint: parsed.mint } : {}),
    });
    ok(res, { signature });
  } catch (err) {
    next(err);
  }
});
