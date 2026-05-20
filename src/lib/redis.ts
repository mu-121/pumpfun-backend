import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
};

export const redis = new Redis(env.REDIS_URL, baseOptions);
export const redisSubscriber = new Redis(env.REDIS_URL, baseOptions);
export const redisPublisher = new Redis(env.REDIS_URL, baseOptions);

for (const [name, client] of [
  ['redis', redis],
  ['redis:sub', redisSubscriber],
  ['redis:pub', redisPublisher],
] as const) {
  client.on('connect', () => logger.debug({ client: name }, 'redis connected'));
  client.on('ready', () => logger.info({ client: name }, 'redis ready'));
  client.on('error', (err: Error) => logger.error({ client: name, err }, 'redis error'));
  client.on('close', () => logger.warn({ client: name }, 'redis connection closed'));
}

export async function publish(channel: string, payload: unknown): Promise<number> {
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return redisPublisher.publish(channel, message);
}

export type Unsubscribe = () => Promise<void>;

export async function subscribe(
  channel: string,
  handler: (message: string, channel: string) => void,
): Promise<Unsubscribe> {
  await redisSubscriber.subscribe(channel);
  const listener = (ch: string, message: string) => {
    if (ch === channel) handler(message, ch);
  };
  redisSubscriber.on('message', listener);
  return async () => {
    redisSubscriber.off('message', listener);
    await redisSubscriber.unsubscribe(channel);
  };
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSubscriber.quit(), redisPublisher.quit()]);
}
