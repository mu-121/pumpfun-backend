import pino, { type Logger } from 'pino';
import { env, isProd } from '../config/env.js';

export const logger: Logger = pino({
  level: isProd ? 'info' : 'debug',
  base: { env: env.NODE_ENV, network: env.SOLANA_NETWORK },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
});

export function child(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
