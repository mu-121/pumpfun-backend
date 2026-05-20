# pump-clone-backend

Backend API for a pump.fun-style token launchpad on Solana, built on top of [Meteora's Dynamic Bonding Curve (DBC)](https://www.meteora.ag/) protocol.

## Stack

- **Runtime:** Node.js 20+, TypeScript (strict)
- **HTTP:** Express 5
- **Database:** PostgreSQL via Prisma ORM
- **Cache / pub-sub / queues:** Redis (ioredis) + BullMQ
- **Logging:** pino (pretty in dev, JSON in prod)
- **Validation:** zod
- **Security:** helmet, cors, express-rate-limit
- **Chain integration:** Solana web3.js + Meteora DBC SDK + Helius RPC/webhooks
- **Storage:** Cloudflare R2 (token images)

## Local development

### 1. Prerequisites
- Node.js 20+
- PostgreSQL 14+ (local or Docker)
- Redis 6+ (local or Docker)

A quick docker-compose for the deps:
```bash
docker run -d --name pump-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pump_clone postgres:16
docker run -d --name pump-redis -p 6379:6379 redis:7
```

### 2. Install
```bash
npm install
```

### 3. Configure env
```bash
cp .env.example .env
# edit .env and fill in real values (see "Env vars" below)
```

### 4. Migrate database
```bash
npm run prisma:generate
npm run prisma:migrate -- --name init
```

### 5. Run
```bash
npm run dev
```
Server listens on `http://localhost:4000`. Sanity check:
```bash
curl http://localhost:4000/health
curl http://localhost:4000/api/v1/ping
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `tsx watch src/server.ts` — hot reload |
| `npm run build` | TypeScript compile to `dist/` |
| `npm start` | Run compiled output |
| `npm test` | Run vitest |
| `npm run prisma:generate` | Regenerate Prisma client |
| `npm run prisma:migrate` | Create + apply a dev migration |
| `npm run prisma:studio` | Open Prisma Studio |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## Deployment

### Docker (recommended for Hetzner / any VPS)
```bash
docker build -t pump-clone-backend .
docker run -d --name pump-backend --env-file .env -p 4000:4000 pump-clone-backend
```
The image is multi-stage: a `builder` stage runs `tsc` and `prisma generate`, then the `runner` stage copies only `dist/`, `prisma/`, and production `node_modules` and drops to a non-root `app` user.

### PM2 (alternative on a bare VPS)
```bash
npm ci --omit=dev
npm run build
pm2 start dist/server.js --name pump-clone-backend --node-args="--enable-source-maps"
pm2 save
```

## One-time setup: Meteora DBC config key

Before the API can launch tokens, you need a Meteora **config key** — an on-chain account that pins down the bonding-curve shape, fees, and migration target. It is created once per launch configuration and reused across every token.

### 1. Generate a platform keypair (if you don't have one yet)
```bash
solana-keygen new --no-bip39-passphrase -o keypair.json
solana address -k keypair.json  # copy this — it's PLATFORM_WALLET_PUBKEY
```
The file must be a 64-byte JSON array. **Add `keypair.json` to `.gitignore`.**

### 2. Fund it on devnet
```bash
solana airdrop 5 $(solana address -k keypair.json) -u devnet
```
You need ~0.05 SOL for rent + tx fees.

### 3. Make sure `.env` is filled in
```
HELIUS_RPC_URL=https://devnet.helius-rpc.com/?api-key=...
PLATFORM_WALLET_PUBKEY=<pubkey from step 1>
PLATFORM_WALLET_KEYPAIR_PATH=./keypair.json
```

### 4. Run the script
```bash
npx tsx scripts/create-config-key.ts
```
On success it prints the new config key pubkey and writes `./config-key.json`.

### 5. Copy the pubkey into `.env`
```
DBC_CONFIG_KEY=<pubkey printed by the script>
```
Restart the dev server. Token launches will now use this config.

### What the default config does
- 1B token supply, 6 decimals
- Migrates at 85 SOL accumulated in the curve
- 20% of supply goes to the migrated DAMM v2 pool (LP fully claimable, no lock)
- Flat 100 bps (1%) trading fee, all to the platform (`creatorTradingFeePercentage=0`)
- No dynamic fee, no rate limiter, no creator vesting
- `Immutable` token update authority (no future metadata changes)

Edit `scripts/create-config-key.ts` to tweak any of this before running.

## Indexer + real-time layer

The server is also a single-process indexer. The flow:

```
Helius webhook → POST /api/v1/webhooks/helius
                     │ (bearer-auth, body validated)
                     ▼
            BullMQ queue: indexer            ← getSignaturesForAddress backfill
                     │
                     ▼
      decode `Program data: …` log lines with anchor BorshCoder
                     │
                     ▼
            evtInitializePool · evtSwap{,2} · evtCurveComplete
                     │
            ┌────────┴─────────┐
            ▼                  ▼
       Postgres write     Redis pub/sub  ───► socket.io rooms ───► browser
       (Trade / Token /                       (`token:<mint>`,
       Holder / Candle)                       `global`, feed rooms)
```

### Redis channels (published by `services/indexer.service.ts`)
- `evt:new-token` — new pool initialized
- `evt:trade:<mint>` — every swap
- `evt:state:<mint>` — reserve/price snapshot after every swap
- `evt:graduation:<mint>` — curve completed, token migrating

### Socket.io rooms (consumers `socket.emit('subscribe', { room })`)
- `global` (auto-joined) — receives `newToken`, `trade`, `graduation`
- `token:<mint>` — receives `trade`, `tokenState`, `graduation`
- `feed:new` / `feed:trending` / `feed:graduating` / `feed:graduated` — feed views

### Aggregator
BullMQ repeatable job runs every 60s ([`src/workers/aggregator.ts`](src/workers/aggregator.ts)). For every trade in the last 10 minutes it upserts OHLCV candles for the `1m / 5m / 1h / 1d` intervals into the `Candle` table. Idempotent — re-runs on the same window yield the same data.

### Backfill
On boot ([`src/workers/backfill.ts`](src/workers/backfill.ts)) the server walks `getSignaturesForAddress` for every non-graduated pool, fetches each transaction it hasn't already indexed (capped at 200 sigs/pool, 24 h of history), and pushes it through the same event-decoding pipeline. This catches anything missed while the webhook was down.

## Helius webhook setup (one-time)

The webhook is what feeds the indexer in real time. In production point Helius at your public URL; in dev tunnel `localhost:4000` with [ngrok](https://ngrok.com/).

### 1. Apply the candle migration first
```bash
npm run prisma:migrate -- --name add_candles
```

### 2. Tunnel localhost (dev only)
```bash
ngrok http 4000
# copy the https URL — e.g. https://abc-123.ngrok-free.app
```

### 3. Register the webhook with Helius
```bash
npx tsx scripts/setup-helius-webhook.ts https://abc-123.ngrok-free.app/api/v1/webhooks/helius
```
The script reads `HELIUS_API_KEY`, `WEBHOOK_AUTH_SECRET`, and `DBC_PROGRAM_ID` from `.env`. It creates (or updates, if you re-run) a `raw` webhook that subscribes to every transaction touching the DBC program and forwards each batch as `Authorization: Bearer <WEBHOOK_AUTH_SECRET>`. The webhook id is written to `webhook-id.txt` (gitignored).

### 4. Verify the webhook locally
```bash
curl -s -X POST http://localhost:4000/api/v1/webhooks/helius \
  -H "Authorization: Bearer $WEBHOOK_AUTH_SECRET" \
  -H "Content-Type: application/json" \
  -d '[{
    "signature": "SAMPLE_SIGNATURE_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "slot": 1,
    "timestamp": 1700000000,
    "feePayer": "11111111111111111111111111111111",
    "meta": { "logMessages": [
      "Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN invoke [1]",
      "Program log: instruction: swap",
      "Program log: not-a-real-event-line",
      "Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN success"
    ] }
  }]'
```
Expected response: `{"accepted":1}` with HTTP 202. The fake log line won't decode to any DBC event, so the indexer will simply log "indexer: ignoring unhandled event" at debug level — but the auth check, body validation, and BullMQ enqueue all run, which is what we want to verify.

To exercise the real pipeline, replay any real DBC transaction's `meta.logMessages` array — those `Program data: …` entries will be Borsh-decoded and dispatched.

## API endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness + version + network |
| GET | `/health/deep` | DB + Redis + Solana RPC checks (503 if any down) |
| GET | `/api/v1/ping` | Round-trip check |
| POST | `/api/v1/tokens/create` | `multipart/form-data` — kick off a launch; returns `{ launchSessionId, unsignedTx, mintAddress }` |
| POST | `/api/v1/tokens/create/submit` | Submit the user-signed launch tx; persists `Token` row |
| GET | `/api/v1/tokens` | List tokens. Query: `sort=new\|trending\|graduating\|graduated`, `limit`, `cursor`, `search` |
| GET | `/api/v1/tokens/:mint` | Token detail (DB row merged with on-chain pool state) |
| GET | `/api/v1/tokens/:mint/holders` | Paginated holders sorted by balance desc |
| GET | `/api/v1/tokens/:mint/trades` | Paginated trades sorted by `blockTime` desc |
| POST | `/api/v1/trade/quote` | Compute a swap quote (no tx) |
| POST | `/api/v1/trade/build` | Build an unsigned swap tx for the user wallet |
| POST | `/api/v1/trade/submit` | Submit the user-signed swap tx, return signature |
| GET | `/api/v1/tokens/:mint/candles` | OHLCV candles (`interval=1m\|5m\|1h\|1d`, `from`/`to` unix seconds, `limit`) |
| POST | `/api/v1/webhooks/helius` | Helius webhook intake (bearer-authed; 202 ack, async processing) |

The server also exposes a **Socket.io endpoint on the same port** (default `4000`) — see the *Indexer + real-time layer* section above for room semantics.

All responses use the envelope `{ success: true, data }` or `{ success: false, error: { code, message } }`. `BigInt` values (lamports, raw token amounts) are serialized as decimal strings.

## Env vars

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `PORT` | no | `4000` | HTTP port |
| `DATABASE_URL` | **yes** | — | Postgres connection string |
| `REDIS_URL` | **yes** | — | Redis connection string |
| `HELIUS_API_KEY` | **yes** | — | Helius API key |
| `HELIUS_RPC_URL` | **yes** | — | Helius RPC endpoint (include API key) |
| `SOLANA_NETWORK` | no | `devnet` | `devnet` \| `mainnet-beta` |
| `DBC_CONFIG_KEY` | no (phase 2) | — | Meteora DBC config account pubkey |
| `DBC_PROGRAM_ID` | no | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | Same on mainnet & devnet |
| `PLATFORM_WALLET_PUBKEY` | **yes** | — | Platform fee recipient pubkey |
| `PLATFORM_WALLET_KEYPAIR_PATH` | only for `scripts/create-config-key.ts` | `./keypair.json` | Path to the platform keypair JSON |
| `R2_ACCOUNT_ID` | **yes** | — | Cloudflare R2 account id |
| `R2_ACCESS_KEY_ID` | **yes** | — | R2 access key |
| `R2_SECRET_ACCESS_KEY` | **yes** | — | R2 secret |
| `R2_BUCKET` | **yes** | — | R2 bucket name |
| `R2_PUBLIC_URL` | **yes** | — | Public base URL for R2 bucket |
| `CORS_ORIGIN` | no | `http://localhost:5173` | Comma-separated origins, or `*` |
| `WEBHOOK_AUTH_SECRET` | **yes** | — | Min 16 chars — used to validate Helius webhooks |

## Repo layout

```
src/
├── config/      # env loading + zod validation
├── lib/         # logger, prisma, redis singletons
├── routes/      # Express route handlers
├── services/    # business logic
├── middleware/  # Express middleware (error handler, auth, etc.)
├── workers/     # BullMQ jobs, indexers
├── types/       # shared TS types
└── server.ts    # entry point
prisma/
└── schema.prisma
```
