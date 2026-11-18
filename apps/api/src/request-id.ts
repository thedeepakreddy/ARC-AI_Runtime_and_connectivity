import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Reuse a well-formed inbound correlation ID, otherwise mint a new one. */
export function genRequestId(req: IncomingMessage): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  return value && SAFE_ID.test(value) ? value : randomUUID();
}
