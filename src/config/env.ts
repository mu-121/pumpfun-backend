import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  HELIUS_API_KEY: z.string().min(1),
  HELIUS_RPC_URL: z.string().url(),
  SOLANA_NETWORK: z.enum(['devnet', 'mainnet-beta']).default('devnet'),

  DBC_CONFIG_KEY: z.string().min(1).optional(),
  DBC_PROGRAM_ID: z.string().min(1).default('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'),

  PLATFORM_WALLET_PUBKEY: z.string().min(1),

  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_PUBLIC_URL: z.string().url(),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  WEBHOOK_AUTH_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env: Env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins: string[] = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
