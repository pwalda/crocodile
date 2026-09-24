import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { fromB64u, toB64u, type PrekeyBundle } from '@crocodile/protocol';
import { randomBytes, x25519 } from './primitives';

export const PREKEY_LIFETIME_MS = 7 * 24 * 3600_000;
/** Old prekey secrets are kept this long after rotation for in-flight boxes. */
export const PREKEY_GRACE_MS = 2 * 24 * 3600_000;

export interface PrekeySecret {
  id: number;
  x25519Secret: string;
  mlkemSecret: string;
  bundle: PrekeyBundle;
}

export function createPrekey(now = Date.now()): PrekeySecret {
  const idBytes = randomBytes(4);
  const id = ((idBytes[0]! << 24) | (idBytes[1]! << 16) | (idBytes[2]! << 8) | idBytes[3]!) >>> 0;
  const xs = randomBytes(32);
  const kem = ml_kem768.keygen(randomBytes(64));
  return {
    id,
    x25519Secret: toB64u(xs),
    mlkemSecret: toB64u(kem.secretKey),
    bundle: {
      id,
      x25519: toB64u(x25519.getPublicKey(xs)),
      mlkem: toB64u(kem.publicKey),
      expiresAt: now + PREKEY_LIFETIME_MS,
    },
  };
}

/**
 * Keeps the current prekey fresh and forgets expired ones (forward secrecy:
 * once a prekey secret is deleted, boxes sealed to it can never be opened).
 */
export function rotatePrekeys(
  current: PrekeySecret[],
  now = Date.now(),
): { keys: PrekeySecret[]; rotated: boolean } {
  const live = current.filter((k) => k.bundle.expiresAt + PREKEY_GRACE_MS > now);
  const newest = live.at(-1);
  // Rotate a day before expiry so peers always see a valid key.
  if (!newest || newest.bundle.expiresAt - 24 * 3600_000 < now) {
    return { keys: [...live, createPrekey(now)], rotated: true };
  }
  return { keys: live, rotated: live.length !== current.length };
}

export function prekeySecrets(k: PrekeySecret) {
  return { x25519: fromB64u(k.x25519Secret), mlkem: fromB64u(k.mlkemSecret) };
}
