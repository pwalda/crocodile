import { z } from 'zod';
import { isCanonicalB64u } from './encoding';

/** Base64url text for exactly `bytes` bytes, in the one spelling toB64u writes. */
export const b64uBytes = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .refine(isCanonicalB64u, 'not base64url as written by toB64u');

/** Ed25519 public key. */
export const keyB64u = b64uBytes(32);
/** Ed25519 signature. */
export const sigB64u = b64uBytes(64);

/** Base64url text of any length (a ciphertext), in the one spelling toB64u writes. */
export const b64uText = z.string().refine(isCanonicalB64u, 'not base64url as written by toB64u');
