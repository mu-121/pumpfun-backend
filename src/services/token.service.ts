import { randomUUID } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  buildCreatePoolTx,
  derivePoolAddress,
  generateMintKeypair,
  getConfigKey,
} from '../lib/dbc.js';
import { confirmTx, connection, getLatestBlockhash, getPriorityFee } from '../lib/solana.js';
import { tokenCount } from '../lib/metrics.js';
import {
  buildTokenMetadata,
  uploadImage,
  uploadMetadata,
} from './storage.service.js';
import { syncTokenReservesFromChain } from './pool-sync.service.js';

const LAUNCH_SESSION_TTL_SECONDS = 600;
const NAME_MAX = 32;
const SYMBOL_MAX = 10;
const DESCRIPTION_MAX = 500;
const SYMBOL_PATTERN = /^[A-Za-z0-9]+$/;

interface LaunchSessionRecord {
  mintAddress: string;
  mintSecretBase58: string;
  poolAddress: string;
  configKey: string;
  creatorAddress: string;
  name: string;
  symbol: string;
  description?: string;
  imageUrl: string;
  metadataUri: string;
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

function sessionKey(id: string): string {
  return `launch:${id}`;
}

export interface CreateTokenLaunchInput {
  creator: string;
  name: string;
  symbol: string;
  description?: string;
  imageBuffer: Buffer;
  imageMime: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface CreateTokenLaunchResult {
  launchSessionId: string;
  unsignedTx: string;
  mintAddress: string;
  poolAddress: string;
  metadataUri: string;
  imageUrl: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

function validateLaunchInput(input: CreateTokenLaunchInput): void {
  if (!input.name || input.name.length === 0 || input.name.length > NAME_MAX) {
    throw new HttpError(400, `name must be 1..${NAME_MAX} chars`);
  }
  if (!input.symbol || input.symbol.length === 0 || input.symbol.length > SYMBOL_MAX) {
    throw new HttpError(400, `symbol must be 1..${SYMBOL_MAX} chars`);
  }
  if (!SYMBOL_PATTERN.test(input.symbol)) {
    throw new HttpError(400, 'symbol must be alphanumeric');
  }
  if (input.description && input.description.length > DESCRIPTION_MAX) {
    throw new HttpError(400, `description must be ≤${DESCRIPTION_MAX} chars`);
  }
  try {
    new PublicKey(input.creator);
  } catch {
    throw new HttpError(400, 'creator must be a valid base58 pubkey');
  }
}

/**
 * Begin a token launch flow.
 *
 * Server-side actions:
 *   1. Generate a fresh mint keypair.
 *   2. Upload image + metadata JSON to R2.
 *   3. Build the create-pool transaction.
 *   4. Partial-sign with the mint keypair.
 *   5. Stash the launch session (mint secret + metadata) in Redis with a 10-min TTL.
 *
 * The returned `unsignedTx` is base64-encoded and still needs the creator wallet's signature.
 * The mint secret never leaves Redis until `submitSignedLaunch` consumes it.
 */
export async function createTokenLaunch(
  input: CreateTokenLaunchInput,
): Promise<CreateTokenLaunchResult> {
  validateLaunchInput(input);
  const configKey = getConfigKey();
  const mint = generateMintKeypair();
  const creator = new PublicKey(input.creator);

  const mintBase58 = mint.publicKey.toBase58();
  const imageKey = `tokens/${mintBase58}/image`;
  const metadataKey = `tokens/${mintBase58}/metadata.json`;

  const imageUrl = await uploadImage(input.imageBuffer, input.imageMime, imageKey);
  const metadata = buildTokenMetadata({
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    imageUrl,
    imageMime: 'image/webp',
    twitter: input.twitter,
    telegram: input.telegram,
    website: input.website,
  });
  const metadataUri = await uploadMetadata(metadata, metadataKey);

  const [priorityFee, blockhash] = await Promise.all([
    getPriorityFee('auto'),
    getLatestBlockhash(),
  ]);

  const tx = await buildCreatePoolTx({
    creator,
    name: input.name,
    symbol: input.symbol,
    uri: metadataUri,
    configKey,
    baseMint: mint.publicKey,
    priorityFeeMicroLamports: priorityFee,
    blockhash,
  });
  tx.sign([mint]);

  const poolAddress = derivePoolAddress(mint.publicKey, configKey).toBase58();
  const launchSessionId = randomUUID();
  const record: LaunchSessionRecord = {
    mintAddress: mintBase58,
    mintSecretBase58: bs58.encode(mint.secretKey),
    poolAddress,
    configKey: configKey.toBase58(),
    creatorAddress: creator.toBase58(),
    name: input.name,
    symbol: input.symbol,
    imageUrl,
    metadataUri,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
  if (input.description) record.description = input.description;
  if (input.twitter) record.twitterUrl = input.twitter;
  if (input.telegram) record.telegramUrl = input.telegram;
  if (input.website) record.websiteUrl = input.website;

  await redis.set(sessionKey(launchSessionId), JSON.stringify(record), 'EX', LAUNCH_SESSION_TTL_SECONDS);

  const unsignedTx = Buffer.from(tx.serialize()).toString('base64');
  return {
    launchSessionId,
    unsignedTx,
    mintAddress: mintBase58,
    poolAddress,
    metadataUri,
    imageUrl,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
}

export interface SubmitSignedLaunchInput {
  launchSessionId: string;
  signedTx: string; // base64 VersionedTransaction
}

export interface SubmitSignedLaunchResult {
  signature: string;
  mintAddress: string;
  poolAddress: string;
  tokenId: string;
}

/**
 * Submit the user-signed launch transaction. Confirms the tx on-chain,
 * then persists the Token row and clears the Redis session.
 */
export async function submitSignedLaunch(
  input: SubmitSignedLaunchInput,
): Promise<SubmitSignedLaunchResult> {
  const raw = await redis.get(sessionKey(input.launchSessionId));
  if (!raw) throw new HttpError(404, 'Launch session not found or expired');
  const record = JSON.parse(raw) as LaunchSessionRecord;

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
    logger.error({ err, launchSessionId: input.launchSessionId }, 'sendRawTransaction failed');
    throw new HttpError(502, 'Failed to send transaction');
  }

  try {
    await confirmTx(signature, record.blockhash, record.lastValidBlockHeight);
  } catch (err) {
    logger.error({ err, signature }, 'launch tx confirmation failed');
    throw new HttpError(502, `Transaction failed to confirm: ${(err as Error).message}`);
  }

  const data: {
    mintAddress: string;
    poolAddress: string;
    configKey: string;
    creatorAddress: string;
    name: string;
    symbol: string;
    description?: string;
    imageUrl: string;
    twitterUrl?: string;
    telegramUrl?: string;
    websiteUrl?: string;
    totalSupply: bigint;
  } = {
    mintAddress: record.mintAddress,
    poolAddress: record.poolAddress,
    configKey: record.configKey,
    creatorAddress: record.creatorAddress,
    name: record.name,
    symbol: record.symbol,
    imageUrl: record.imageUrl,
    totalSupply: 1_000_000_000_000_000n,
  };
  if (record.description) data.description = record.description;
  if (record.twitterUrl) data.twitterUrl = record.twitterUrl;
  if (record.telegramUrl) data.telegramUrl = record.telegramUrl;
  if (record.websiteUrl) data.websiteUrl = record.websiteUrl;

  const token = await prisma.token.create({ data });
  tokenCount.inc();
  await redis.del(sessionKey(input.launchSessionId));

  try {
    await syncTokenReservesFromChain(token.mintAddress);
  } catch (err) {
    logger.warn({ err, mint: token.mintAddress }, 'post-launch reserve sync failed');
  }

  return {
    signature,
    mintAddress: token.mintAddress,
    poolAddress: token.poolAddress,
    tokenId: token.id,
  };
}
