import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../middleware/errorHandler.js';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_IMAGE_DIMENSION = 512;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

function publicUrl(key: string): string {
  const base = env.R2_PUBLIC_URL.replace(/\/$/, '');
  const path = key.replace(/^\//, '');
  return `${base}/${path}`;
}

function assertR2UploadOk(err: unknown): never {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
  if (name === 'NoSuchBucket') {
    throw new HttpError(
      503,
      `R2 bucket "${env.R2_BUCKET}" does not exist. Create it in the Cloudflare dashboard and match R2_BUCKET in .env.`,
    );
  }
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    throw new HttpError(
      503,
      'R2 credentials are invalid. Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.',
    );
  }
  logger.error({ err }, 'R2 upload failed');
  throw new HttpError(503, 'Image storage upload failed');
}

async function putObject(command: PutObjectCommand): Promise<void> {
  try {
    await r2.send(command);
  } catch (err) {
    assertR2UploadOk(err);
  }
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  description?: string;
  image: string;
  external_url?: string;
  attributes?: Array<{ trait_type: string; value: string }>;
  properties: {
    files: Array<{ uri: string; type: string }>;
    category: 'image';
  };
  extensions?: {
    twitter?: string;
    telegram?: string;
    website?: string;
  };
}

/**
 * Validate, resize, strip EXIF, and upload a token image to R2.
 * @param buffer - Raw upload buffer (≤2MB).
 * @param mimeType - Reported MIME type.
 * @param key - Object key under the R2 bucket (e.g. `tokens/<mint>/image.webp`).
 * @returns The public URL of the uploaded object.
 */
export async function uploadImage(
  buffer: Buffer,
  mimeType: string,
  key: string,
): Promise<string> {
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, `Image exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new HttpError(400, `Unsupported image type: ${mimeType}`);
  }

  let processed: Buffer;
  let outputMime: string;
  try {
    if (mimeType === 'image/gif') {
      // Preserve animation, just downscale.
      processed = await sharp(buffer, { animated: true })
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .gif()
        .toBuffer();
      outputMime = 'image/gif';
    } else {
      processed = await sharp(buffer)
        .rotate() // honor EXIF orientation before stripping
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 90 })
        .toBuffer();
      outputMime = 'image/webp';
    }
  } catch (err) {
    logger.warn({ err, mimeType, byteLength: buffer.length }, 'image processing failed');
    throw new HttpError(400, 'Image could not be processed');
  }

  await putObject(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: processed,
      ContentType: outputMime,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return publicUrl(key);
}

/**
 * Upload Metaplex-compatible token metadata JSON to R2.
 * @returns The public URL pointing at the JSON object.
 */
export async function uploadMetadata(metadata: TokenMetadata, key: string): Promise<string> {
  const body = Buffer.from(JSON.stringify(metadata), 'utf8');
  await putObject(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return publicUrl(key);
}

/**
 * Build a Metaplex-style token metadata document.
 * Caller still needs to upload it with `uploadMetadata`.
 */
export function buildTokenMetadata(input: {
  name: string;
  symbol: string;
  description?: string;
  imageUrl: string;
  imageMime: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}): TokenMetadata {
  const meta: TokenMetadata = {
    name: input.name,
    symbol: input.symbol,
    image: input.imageUrl,
    properties: {
      files: [{ uri: input.imageUrl, type: input.imageMime }],
      category: 'image',
    },
  };
  if (input.description) meta.description = input.description;
  if (input.website) meta.external_url = input.website;
  const extensions: NonNullable<TokenMetadata['extensions']> = {};
  if (input.twitter) extensions.twitter = input.twitter;
  if (input.telegram) extensions.telegram = input.telegram;
  if (input.website) extensions.website = input.website;
  if (Object.keys(extensions).length > 0) meta.extensions = extensions;
  return meta;
}
