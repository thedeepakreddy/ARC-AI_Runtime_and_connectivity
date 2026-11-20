import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ArcError } from '../errors.js';

/**
 * An app vouches for one of its own users with this header (its ARC key proves the app). The
 * id is opaque to ARC: use a stable id from your user database, not an email address.
 */
export const END_USER_HEADER = 'x-arc-user';
const USER_ID = /^[A-Za-z0-9._:@|-]{1,128}$/;

/**
 * SHA-256 of "<app id>:<user id>", or null without the header. ARC stores and compares only
 * this hash, so the raw user id never reaches the database or logs, and the same person in two
 * apps can't be correlated.
 */
export function endUserHash(req: FastifyRequest, applicationId: string): string | null {
  const raw = req.headers[END_USER_HEADER];
  if (raw === undefined) return null;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !USER_ID.test(id)) {
    throw new ArcError(
      400,
      'invalid_end_user',
      `${END_USER_HEADER} must be 1–128 characters: letters, digits and . _ : @ | -`,
    );
  }
  return createHash('sha256').update(`${applicationId}:${id}`, 'utf8').digest('hex');
}
