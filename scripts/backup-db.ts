/**
 * Standalone CLI: `pg_dump` the production database to a timestamped file and,
 * optionally, upload to Cloudflare R2 for off-site storage.
 *
 * Run via:
 *   tsx scripts/backup-db.ts
 *   tsx scripts/backup-db.ts --upload
 *
 * Required env:
 *   - DATABASE_URL
 *
 * Optional env (only needed with --upload):
 *   - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Recommended cron (nightly at 03:00 UTC):
 *   0 3 * * *  cd /srv/pump-clone-backend && /usr/bin/npx tsx scripts/backup-db.ts --upload >> /var/log/pump-backup.log 2>&1
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const dbUrl = requireEnv('DATABASE_URL');
  const upload = process.argv.includes('--upload');
  const outDir = path.resolve('./backups');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `pump-clone-${stamp}.sql.gz`);

  console.log(`Dumping to ${file}…`);
  // `pg_dump` directly to gzip via shell pipe — execFileSync doesn't pipe, so
  // we use sh -c with careful quoting.
  execFileSync(
    'sh',
    ['-c', `pg_dump "${dbUrl}" --no-owner --no-privileges | gzip > "${file}"`],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const bytes = statSync(file).size;
  console.log(`Wrote ${(bytes / 1024 / 1024).toFixed(2)} MB`);

  if (!upload) return;

  const accountId = requireEnv('R2_ACCOUNT_ID');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const bucket = requireEnv('R2_BUCKET');

  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  const key = `backups/${path.basename(file)}`;
  console.log(`Uploading to R2 → ${bucket}/${key}…`);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readFileSync(file),
      ContentType: 'application/gzip',
    }),
  );
  console.log('Upload complete.');
  // Keep the local copy too — operators can rotate as they see fit.
  void unlinkSync;
}

main().catch((err) => {
  console.error('backup failed:', err);
  process.exit(1);
});
