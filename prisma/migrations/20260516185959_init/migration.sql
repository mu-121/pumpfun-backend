-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "mintAddress" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "creatorAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "twitterUrl" TEXT,
    "telegramUrl" TEXT,
    "websiteUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graduatedAt" TIMESTAMP(3),
    "graduatedPoolAddress" TEXT,
    "isGraduated" BOOLEAN NOT NULL DEFAULT false,
    "virtualSolReserves" BIGINT NOT NULL DEFAULT 0,
    "virtualTokenReserves" BIGINT NOT NULL DEFAULT 0,
    "realSolReserves" BIGINT NOT NULL DEFAULT 0,
    "realTokenReserves" BIGINT NOT NULL DEFAULT 0,
    "totalSupply" BIGINT NOT NULL,
    "lastTradeAt" TIMESTAMP(3),
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "marketCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "traderAddress" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "solAmount" BIGINT NOT NULL,
    "tokenAmount" BIGINT NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "priceSol" DOUBLE PRECISION NOT NULL,
    "slot" BIGINT NOT NULL,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holder" (
    "id" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "balance" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Token_mintAddress_key" ON "Token"("mintAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Token_poolAddress_key" ON "Token"("poolAddress");

-- CreateIndex
CREATE INDEX "Token_createdAt_idx" ON "Token"("createdAt");

-- CreateIndex
CREATE INDEX "Token_lastTradeAt_idx" ON "Token"("lastTradeAt");

-- CreateIndex
CREATE INDEX "Token_isGraduated_idx" ON "Token"("isGraduated");

-- CreateIndex
CREATE INDEX "Token_creatorAddress_idx" ON "Token"("creatorAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_signature_key" ON "Trade"("signature");

-- CreateIndex
CREATE INDEX "Trade_tokenMint_blockTime_idx" ON "Trade"("tokenMint", "blockTime");

-- CreateIndex
CREATE INDEX "Trade_traderAddress_idx" ON "Trade"("traderAddress");

-- CreateIndex
CREATE INDEX "Trade_blockTime_idx" ON "Trade"("blockTime");

-- CreateIndex
CREATE INDEX "Holder_tokenMint_balance_idx" ON "Holder"("tokenMint", "balance");

-- CreateIndex
CREATE INDEX "Holder_walletAddress_idx" ON "Holder"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Holder_tokenMint_walletAddress_key" ON "Holder"("tokenMint", "walletAddress");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_tokenMint_fkey" FOREIGN KEY ("tokenMint") REFERENCES "Token"("mintAddress") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holder" ADD CONSTRAINT "Holder_tokenMint_fkey" FOREIGN KEY ("tokenMint") REFERENCES "Token"("mintAddress") ON DELETE CASCADE ON UPDATE CASCADE;
