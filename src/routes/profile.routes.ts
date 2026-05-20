import { Router } from 'express';
import { PublicKey } from '@solana/web3.js';
import { ok } from '../lib/http.js';
import { HttpError } from '../middleware/errorHandler.js';
import { getProfile } from '../services/profile.service.js';

export const profileRouter: Router = Router();

profileRouter.get('/:address', async (req, res, next) => {
  try {
    const address = req.params.address;
    if (!address) throw new HttpError(400, 'address is required');
    try {
      new PublicKey(address);
    } catch {
      throw new HttpError(400, 'address must be a valid base58 pubkey');
    }
    const fresh = req.query.fresh === '1';
    const profile = await getProfile(address, { fresh });
    ok(res, profile);
  } catch (err) {
    next(err);
  }
});
