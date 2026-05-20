/**
 * Standalone CLI: create or update a Helius webhook so that it forwards every
 * Dynamic Bonding Curve transaction to our /api/v1/webhooks/helius endpoint.
 *
 * Usage:
 *   tsx scripts/setup-helius-webhook.ts <webhookURL>
 *
 * Example:
 *   tsx scripts/setup-helius-webhook.ts https://abc-123.ngrok-free.app/api/v1/webhooks/helius
 *
 * Required env:
 *   - HELIUS_API_KEY
 *   - WEBHOOK_AUTH_SECRET
 *   - DBC_PROGRAM_ID
 *
 * On success the webhook id is appended to ./webhook-id.txt.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  accountAddresses: string[];
  webhookType: string;
  transactionTypes: string[];
  authHeader?: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function listWebhooks(apiKey: string): Promise<HeliusWebhook[]> {
  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`);
  if (!res.ok) {
    throw new Error(`listWebhooks failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as HeliusWebhook[];
}

async function createWebhook(apiKey: string, body: object): Promise<HeliusWebhook> {
  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createWebhook failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as HeliusWebhook;
}

async function editWebhook(
  apiKey: string,
  id: string,
  body: object,
): Promise<HeliusWebhook> {
  const res = await fetch(`https://api.helius.xyz/v0/webhooks/${id}?api-key=${apiKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`editWebhook failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as HeliusWebhook;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('HELIUS_API_KEY');
  const secret = requireEnv('WEBHOOK_AUTH_SECRET');
  const programId = requireEnv('DBC_PROGRAM_ID');

  const webhookUrl = process.argv[2];
  if (!webhookUrl) {
    console.error('Usage: tsx scripts/setup-helius-webhook.ts <publicly-reachable webhookURL>');
    console.error('Tip: use `ngrok http 4000` and paste the https URL + /api/v1/webhooks/helius');
    process.exit(1);
  }

  const payload = {
    webhookURL: webhookUrl,
    accountAddresses: [programId],
    transactionTypes: ['Any'],
    webhookType: 'raw',
    authHeader: `Bearer ${secret}`,
  };

  // If an existing webhook already targets the same URL or program, update it.
  let existing: HeliusWebhook | undefined;
  const idFile = path.resolve('./webhook-id.txt');
  if (existsSync(idFile)) {
    const id = readFileSync(idFile, 'utf8').trim();
    if (id) {
      const all = await listWebhooks(apiKey);
      existing = all.find((w) => w.webhookID === id);
    }
  }
  if (!existing) {
    const all = await listWebhooks(apiKey);
    existing = all.find(
      (w) => w.webhookURL === webhookUrl || w.accountAddresses.includes(programId),
    );
  }

  let webhook: HeliusWebhook;
  if (existing) {
    console.log(`Updating existing webhook ${existing.webhookID}…`);
    webhook = await editWebhook(apiKey, existing.webhookID, payload);
  } else {
    console.log('Creating new webhook…');
    webhook = await createWebhook(apiKey, payload);
  }

  writeFileSync(
    idFile,
    JSON.stringify({ webhookID: webhook.webhookID, webhookURL: webhook.webhookURL }, null, 2),
  );
  console.log(`\nWebhook ${webhook.webhookID} configured for ${webhook.webhookURL}`);
  console.log(`Wrote ${idFile}`);
}

main().catch((err) => {
  console.error('setup-helius-webhook failed:', err);
  process.exit(1);
});
