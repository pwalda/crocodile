import { z } from 'zod';
import { isCanonicalB64u } from './encoding';

/** Base64url text for exactly `bytes` bytes, in the one spelling toB64u writes. */
export const b64uBytes = (bytes: number) =>
  z
    .string()
    .check(
      z.length(Math.ceil((bytes * 4) / 3), { abort: true }),
      z.refine(isCanonicalB64u, 'not base64url as written by toB64u'),
    );

/** Ed25519 public key. */
export const keyB64u = b64uBytes(32);
/** Ed25519 signature. */
export const sigB64u = b64uBytes(64);

/**
 * Base64url text of at most `max` characters (a ciphertext), in the one spelling toB64u writes.
 * The length is checked first, so a string that is too long is refused before it is read.
 */
export const b64uText = (max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .check(
      z.maxLength(max, { abort: true }),
      z.refine(isCanonicalB64u, 'not base64url as written by toB64u'),
    );
