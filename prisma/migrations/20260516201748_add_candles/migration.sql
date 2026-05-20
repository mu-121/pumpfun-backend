-- CreateEnum
CREATE TYPE "CandleInterval" AS ENUM ('ONE_MIN', 'FIVE_MIN', 'ONE_HOUR', 'ONE_DAY');

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volumeSol" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volumeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trades" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Candle_tokenMint_interval_bucketStart_idx" ON "Candle"("tokenMint", "interval", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_tokenMint_interval_bucketStart_key" ON "Candle"("tokenMint", "interval", "bucketStart");

-- AddForeignKey
ALTER TABLE "Candle" ADD CONSTRAINT "Candle_tokenMint_fkey" FOREIGN KEY ("tokenMint") REFERENCES "Token"("mintAddress") ON DELETE CASCADE ON UPDATE CASCADE;
