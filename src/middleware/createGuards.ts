import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../lib/solana.js';
import { redis } from '../lib/redis.js';
import { containsProfanity } from '../lib/profanity.js';
import { HttpError } from './errorHandler.js';

const MIN_CREATOR_BALANCE_LAMPORTS = 50_000_000n; // 0.05 SOL
const WALLET_CREATE_PER_HOUR = 5;
const IMAGE_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Body validation + anti-spam guards for `POST /api/v1/tokens/create`.
 *
 * Runs AFTER multer (so `req.body` and `req.file` are populated). The order
 * matters: cheap checks first, RPC + Redis last.
 *
 *   1. Profanity on name / symbol / description
 *   2. Image hash dedupe (24 h window keyed by sha256 of the buffer)
 *   3. Per-wallet rate limit (5 launches / rolling hour, tracked in Redis)
 *   4. Minimum 0.05 SOL balance on the creator wallet (Solana RPC)
 */
export const createGuards: RequestHandler = async (req, _res, next) => {
  try {
    const body = req.body as {
      name?: string;
      symbol?: string;
      description?: string;
      creatorAddress?: string;
    };

    if (containsProfanity(body.name, body.symbol, body.description)) {
      throw new HttpError(400, 'Name, symbol, or description contains disallowed words.');
    }

    // ---- Image dedupe ----
    const file = req.file;
    if (file?.buffer) {
      const hash = createHash('sha256').update(file.buffer).digest('hex');
      const key = `dup:img:${hash}`;
      const existing = await redis.get(key);
      if (existing) {
        throw new HttpError(409, 'This image was used by another token recently. Use a different image.');
      }
      // Reserve the hash. We'll keep it whether or not the launch succeeds —
      // worst case the user has to use a different image on retry, which is
      // a fine trade-off for cheap dedupe.
      await redis.set(key, '1', 'EX', IMAGE_DEDUPE_TTL_SECONDS, 'NX');
    }

    // ---- Per-wallet rate limit ----
    if (!body.creatorAddress) {
      throw new HttpError(400, 'creatorAddress is required');
    }
    try {
      new PublicKey(body.creatorAddress);
    } catch {
      throw new HttpError(400, 'creatorAddress must be a valid base58 pubkey');
    }
    const rateKey = `rl:create:${body.creatorAddress}`;
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, 3600);
    if (count > WALLET_CREATE_PER_HOUR) {
      throw new HttpError(
        429,
        `Too many launches from this wallet — limit is ${WALLET_CREATE_PER_HOUR}/hour.`,
      );
    }

    // ---- Creator balance check ----
    try {
      const balance = BigInt(
        await connection.getBalance(new PublicKey(body.creatorAddress), 'confirmed'),
      );
      if (balance < MIN_CREATOR_BALANCE_LAMPORTS) {
        throw new HttpError(
          402,
          'Creator wallet needs at least 0.05 SOL to launch a token.',
        );
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // RPC hiccup — don't block the user, but log via req.log if available.
      req.log?.warn({ err }, 'creator balance check failed; allowing launch');
    }

    next();
  } catch (err) {
    next(err);
  }
};
