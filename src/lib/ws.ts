import { Server as HttpServer } from 'node:http';
import { Server as IoServer, type Socket } from 'socket.io';
import { corsOrigins } from '../config/env.js';
import { logger } from './logger.js';
import { publish, redisSubscriber } from './redis.js';

/** Redis pub/sub channels published by the indexer and consumed by the WS layer. */
export const Channels = {
  newToken: 'evt:new-token',
  trade: (mint: string): string => `evt:trade:${mint}`,
  tokenState: (mint: string): string => `evt:state:${mint}`,
  graduation: (mint: string): string => `evt:graduation:${mint}`,
  /** Pattern subscribed by the WS layer to receive all token-scoped events. */
  perToken: 'evt:trade:*',
  perTokenState: 'evt:state:*',
  perTokenGraduation: 'evt:graduation:*',
} as const;

/** Socket.io rooms emitted to from the WS layer. */
export const Rooms = {
  global: 'global',
  token: (mint: string): string => `token:${mint}`,
  feedNew: 'feed:new',
  feedTrending: 'feed:trending',
  feedGraduating: 'feed:graduating',
  feedGraduated: 'feed:graduated',
} as const;

const VALID_FEED_ROOMS = new Set<string>([
  Rooms.feedNew,
  Rooms.feedTrending,
  Rooms.feedGraduating,
  Rooms.feedGraduated,
]);

let io: IoServer | undefined;

/**
 * Attach a socket.io server to the given Node http.Server.
 *
 * Clients can `socket.emit('subscribe', { room })` to join a room:
 *   - `token:<mint>` — per-token events
 *   - `feed:new|trending|graduating|graduated` — feed views
 * Every connection auto-joins the `global` room.
 *
 * Returns the io instance; callers should store it if they need to emit directly.
 */
export function attachWebSocket(httpServer: HttpServer): IoServer {
  io = new IoServer(httpServer, {
    cors: {
      origin: corsOrigins.includes('*') ? true : corsOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket: Socket) => {
    socket.join(Rooms.global);
    logger.debug({ socketId: socket.id }, 'ws connected');

    socket.on('subscribe', (payload: unknown) => {
      const room = parseRoomRequest(payload);
      if (!room) return;
      socket.join(room);
    });
    socket.on('unsubscribe', (payload: unknown) => {
      const room = parseRoomRequest(payload);
      if (!room) return;
      socket.leave(room);
    });
    socket.on('disconnect', () => {
      logger.debug({ socketId: socket.id }, 'ws disconnected');
    });
  });

  startRedisBridge();
  return io;
}

function parseRoomRequest(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const room = (payload as { room?: unknown }).room;
  if (typeof room !== 'string') return undefined;
  if (room.startsWith('token:')) {
    const mint = room.slice('token:'.length);
    if (mint.length < 32 || mint.length > 44) return undefined;
    return room;
  }
  if (VALID_FEED_ROOMS.has(room)) return room;
  return undefined;
}

/**
 * Wire Redis pattern-subscriptions to socket.io broadcast.
 * Indexer publishes; this layer fans out to rooms.
 */
function startRedisBridge(): void {
  redisSubscriber.psubscribe(
    Channels.perToken,
    Channels.perTokenState,
    Channels.perTokenGraduation,
    Channels.newToken,
    (err) => {
      if (err) logger.error({ err }, 'redis psubscribe failed');
    },
  );

  redisSubscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!io) return;
    let payload: unknown;
    try {
      payload = JSON.parse(message);
    } catch (err) {
      logger.warn({ err, channel }, 'failed to parse redis message');
      return;
    }

    if (channel === Channels.newToken) {
      io.to(Rooms.global).emit('newToken', payload);
      io.to(Rooms.feedNew).emit('newToken', payload);
      return;
    }
    const mint = extractMint(channel);
    if (!mint) return;
    if (channel.startsWith('evt:trade:')) {
      io.to(Rooms.token(mint)).emit('trade', payload);
      io.to(Rooms.global).emit('trade', payload);
    } else if (channel.startsWith('evt:state:')) {
      io.to(Rooms.token(mint)).emit('tokenState', payload);
    } else if (channel.startsWith('evt:graduation:')) {
      io.to(Rooms.token(mint)).emit('graduation', payload);
      io.to(Rooms.global).emit('graduation', payload);
      io.to(Rooms.feedGraduated).emit('graduation', payload);
    }
  });

  redisSubscriber.on('message', (channel: string, message: string) => {
    // `subscribe()` (non-pattern) hits this handler. We don't use exact subscribes
    // for events anymore, but it's already used by Channels.newToken which is
    // also captured by the pattern above; ignore here to avoid duplicate emits.
    void channel;
    void message;
  });
}

function extractMint(channel: string): string | undefined {
  const lastColon = channel.lastIndexOf(':');
  if (lastColon === -1) return undefined;
  return channel.slice(lastColon + 1);
}

export function getIo(): IoServer | undefined {
  return io;
}

// ---- Named emit helpers ----
//
// These all go through Redis pub/sub so the WS layer can be split off the
// indexer process later without changing call sites. In-process the WS bridge
// (`startRedisBridge`) consumes from Redis and fans out to socket.io rooms.

/** Publish a "new token created" event. Broadcast to `global` + `feed:new`. */
export async function emitNewToken(token: {
  mintAddress: string;
  poolAddress: string;
  name?: string;
  symbol?: string;
  creatorAddress?: string;
  imageUrl?: string;
}): Promise<void> {
  await publish(Channels.newToken, token);
}

/** Publish a swap. Broadcast to `token:<mint>` + `global`. */
export async function emitTrade(
  mintAddress: string,
  trade: Record<string, unknown>,
  tokenState?: Record<string, unknown>,
): Promise<void> {
  await publish(Channels.trade(mintAddress), trade);
  if (tokenState) await publish(Channels.tokenState(mintAddress), tokenState);
}

/** Publish a token-state update (reserves / price snapshot). */
export async function emitTokenStateUpdate(
  mintAddress: string,
  state: Record<string, unknown>,
): Promise<void> {
  await publish(Channels.tokenState(mintAddress), state);
}

/** Publish a graduation event. Broadcast to `token:<mint>` + `global` + `feed:graduated`. */
export async function emitGraduation(
  mintAddress: string,
  payload: { graduatedPoolAddress: string; signature?: string; blockTime?: string },
): Promise<void> {
  await publish(Channels.graduation(mintAddress), { mintAddress, ...payload });
}
