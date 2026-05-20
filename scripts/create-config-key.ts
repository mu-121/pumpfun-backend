/**
 * Standalone CLI script: provision a Meteora DBC config key.
 *
 * Run via: `tsx scripts/create-config-key.ts`
 *
 * Required env:
 *   - HELIUS_RPC_URL              (or any Solana RPC URL)
 *   - PLATFORM_WALLET_PUBKEY      (recipient of trading fees)
 *   - PLATFORM_WALLET_KEYPAIR_PATH (path to a Solana keypair JSON — 64-byte array)
 *
 * The script:
 *   1. Loads the platform keypair from disk
 *   2. Builds a pump.fun-style ConfigParameters payload via `buildCurve(...)`
 *   3. Creates a fresh config-key account (server-side Keypair)
 *   4. Sends the createConfig tx, waits for confirmation
 *   5. Writes the new config pubkey to ./config-key.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigratedCollectFeeMode,
  DammV2DynamicFeeMode,
  MigrationFeeOption,
  MigrationOption,
  PartnerService,
  TokenDecimal,
  TokenType,
  TokenUpdateAuthorityOption,
  buildCurve,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

loadDotenv();

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

function loadKeypair(filepath: string): Keypair {
  const abs = path.resolve(filepath);
  const raw = readFileSync(abs, 'utf8');
  const bytes = JSON.parse(raw);
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`Keypair file ${abs} is not a 64-byte JSON array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function main(): Promise<void> {
  const rpcUrl = requireEnv('HELIUS_RPC_URL');
  const feeClaimer = new PublicKey(requireEnv('PLATFORM_WALLET_PUBKEY'));
  const keypairPath = requireEnv('PLATFORM_WALLET_KEYPAIR_PATH');

  const payer = loadKeypair(keypairPath);
  if (!payer.publicKey.equals(feeClaimer)) {
    console.warn(
      `Warning: PLATFORM_WALLET_PUBKEY (${feeClaimer.toBase58()}) does not match keypair ` +
        `(${payer.publicKey.toBase58()}). The keypair will pay; the configured pubkey will receive fees.`,
    );
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05 * 1e9) {
    console.warn('Low balance — config creation costs rent + fees. Consider airdropping.');
  }

  // ---- Curve construction (pump.fun-style) ----
  //
  // Total supply  : 1B tokens (with 6 decimals → 1_000_000_000_000_000 raw units)
  // Migration when: 85 SOL accumulated in the curve's quote reserve
  // % to LP       : 20% of supply goes to the migrated AMM pool at graduation
  // Base fee      : 100 bps (1%) flat — all to platform (creatorTradingFeePercentage=0)
  const configParams = buildCurve({
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 85,
    token: {
      tokenType: TokenType.SPL,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: 100,
          endingFeeBps: 100,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: 0,
      },
    },
    liquidityDistribution: {
      // SDK requires ≥10% (1000 bps) locked liquidity at migration day 1.
      partnerPermanentLockedLiquidityPercentage: 10,
      partnerLiquidityPercentage: 90,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
  });

  // ---- Send createConfig tx ----
  const config = Keypair.generate();
  console.log(`New config key: ${config.publicKey.toBase58()}`);

  const partner = new PartnerService(connection, 'confirmed');
  const tx: Transaction = await partner.createConfig({
    config: config.publicKey,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    quoteMint: WSOL_MINT,
    payer: payer.publicKey,
    ...configParams,
  });

  console.log('Sending createConfig transaction…');
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, config], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`Confirmed: ${sig}`);

  const outPath = path.resolve('./config-key.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        configKey: config.publicKey.toBase58(),
        feeClaimer: feeClaimer.toBase58(),
        signature: sig,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outPath}`);
  console.log(`\nNext step: set DBC_CONFIG_KEY=${config.publicKey.toBase58()} in your .env`);
}

main().catch((err) => {
  console.error('create-config-key failed:', err);
  process.exit(1);
});
