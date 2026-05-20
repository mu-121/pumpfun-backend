import type { Response } from 'express';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Recursively convert BigInt values in `value` to strings, leaving everything else intact.
 * JSON.stringify chokes on BigInt by default; we serialize them as decimal strings on the wire.
 */
export function serializeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as unknown as T;
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serializeBigInts) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeBigInts(v);
    }
    return out as T;
  }
  return value;
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ success: true, data: serializeBigInts(data) });
}

export function fail(res: Response, status: number, error: ApiError): Response {
  return res.status(status).json({ success: false, error });
}
