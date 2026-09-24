import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { canonicalJson, fromB64u, toB64u, utf8 } from '@crocodile/protocol';

export { ed25519, x25519, sha256 };

export function randomBytes(n: number): Uint8Array {
  return nobleRandomBytes(n);
}

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8.encode(info), length);
}

export function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
) {
  return gcm(key, nonce, aad).encrypt(plaintext);
}

/** Returns null instead of throwing when authentication fails. */
export function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Uint8Array | null {
  try {
    return gcm(key, nonce, aad).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** Bytes that get signed: a domain tag plus canonical JSON of the payload. */
export function signingBytes(domain: string, payload: unknown): Uint8Array {
  return utf8.encode(`${domain}\n${canonicalJson(payload)}`);
}

export function signPayload(secretKey: Uint8Array, domain: string, payload: unknown): string {
  return toB64u(ed25519.sign(signingBytes(domain, payload), secretKey));
}

export function verifyPayload(
  publicKeyB64u: string,
  domain: string,
  payload: unknown,
  sigB64u: string,
): boolean {
  try {
    const pub = fromB64u(publicKeyB64u);
    const sig = fromB64u(sigB64u);
    if (pub.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, signingBytes(domain, payload), pub);
  } catch {
    return false;
  }
}
