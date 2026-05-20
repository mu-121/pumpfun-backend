import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env.js';
import { logger } from './logger.js';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: isProd
      ? [{ emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }]
      : [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
  });

if (!isProd) {
  global.__prisma = prisma;
}

// @ts-expect-error — Prisma's event emitter typings vary by version
prisma.$on('error', (e: unknown) => logger.error({ e }, 'prisma error'));
// @ts-expect-error — Prisma's event emitter typings vary by version
prisma.$on('warn', (e: unknown) => logger.warn({ e }, 'prisma warn'));

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}
