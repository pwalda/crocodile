import { toB64u, fromB64u } from '@crocodile/protocol';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, randomBytes } from './primitives';

/**
 * Sender keys (as in Signal groups / SFrame): every participant encrypts its
 * outgoing voice frames and group text with its own symmetric key, which it
 * hands to each other participant through a sealed box. The host relay
 * forwards ciphertext it cannot decrypt. Keys rotate whenever someone leaves.
 *
 * Voice frame layout (appended trailer, SFrame-like):
 *
 *   ciphertext || GCM tag (16) || kid u32 BE || counter u32 BE || 0xC7
 *
 * nonce = salt XOR (0^4 || kid || counter), AAD = trailer.
 */
export const FRAME_MAGIC = 0xc7;
export const FRAME_TRAILER_BYTES = 9;
const TAG_BYTES = 16;

export interface SenderKey {
  kid: number;
  secret: Uint8Array;
}

export interface DerivedSenderKey {
  kid: number;
  audioKey: Uint8Array;
  audioSalt: Uint8Array;
  textKey: Uint8Array;
  textSalt: Uint8Array;
}

export function createSenderKey(): SenderKey {
  const kidBytes = randomBytes(4);
  const kid = ((kidBytes[0]! << 24) | (kidBytes[1]! << 16) | (kidBytes[2]! << 8) | kidBytes[3]!) >>> 0;
  return { kid, secret: randomBytes(32) };
}

export function deriveSenderKey(sk: SenderKey): DerivedSenderKey {
  const salt = new Uint8Array(4);
  new DataView(salt.buffer).setUint32(0, sk.kid);
  const audio = hkdfSha256(sk.secret, salt, 'croc/v1/frame/audio', 44);
  const text = hkdfSha256(sk.secret, salt, 'croc/v1/frame/text', 44);
  return {
    kid: sk.kid,
    audioKey: audio.slice(0, 32),
    audioSalt: audio.slice(32, 44),
    textKey: text.slice(0, 32),
    textSalt: text.slice(32, 44),
  };
}

export function exportSenderKey(sk: SenderKey): string {
  return toB64u(sk.secret);
}

export function importSenderKey(kid: number, secret: string): SenderKey {
  const bytes = fromB64u(secret);
  if (bytes.length !== 32) throw new Error('bad sender key');
  return { kid: kid >>> 0, secret: bytes };
}

function nonceFor(salt: Uint8Array, kid: number, counter: number): Uint8Array {
  const nonce = salt.slice();
  const view = new DataView(nonce.buffer);
  view.setUint32(4, view.getUint32(4) ^ kid);
  view.setUint32(8, view.getUint32(8) ^ counter);
  return nonce;
}

export function encryptFrame(key: DerivedSenderKey, counter: number, frame: Uint8Array): Uint8Array {
  const trailer = new Uint8Array(FRAME_TRAILER_BYTES);
  const tv = new DataView(trailer.buffer);
  tv.setUint32(0, key.kid);
  tv.setUint32(4, counter >>> 0);
  trailer[8] = FRAME_MAGIC;
  const ct = aesGcmEncrypt(key.audioKey, nonceFor(key.audioSalt, key.kid, counter >>> 0), frame, trailer);
  const out = new Uint8Array(ct.length + FRAME_TRAILER_BYTES);
  out.set(ct, 0);
  out.set(trailer, ct.length);
  return out;
}

export function peekFrameKid(data: Uint8Array): number | null {
  if (data.length < FRAME_TRAILER_BYTES + TAG_BYTES) return null;
  if (data[data.length - 1] !== FRAME_MAGIC) return null;
  return new DataView(data.buffer, data.byteOffset + data.length - FRAME_TRAILER_BYTES, 4).getUint32(0);
}

export function decryptFrame(key: DerivedSenderKey, data: Uint8Array): Uint8Array | null {
  if (data.length < FRAME_TRAILER_BYTES + TAG_BYTES || data[data.length - 1] !== FRAME_MAGIC) return null;
  const trailer = data.subarray(data.length - FRAME_TRAILER_BYTES);
  const tv = new DataView(trailer.buffer, trailer.byteOffset, FRAME_TRAILER_BYTES);
  const kid = tv.getUint32(0);
  if (kid !== key.kid) return null;
  const counter = tv.getUint32(4);
  return aesGcmDecrypt(
    key.audioKey,
    nonceFor(key.audioSalt, kid, counter),
    data.subarray(0, data.length - FRAME_TRAILER_BYTES),
    trailer,
  );
}

export function encryptGroup(key: DerivedSenderKey, counter: number, plaintext: Uint8Array) {
  const aad = new Uint8Array(8);
  new DataView(aad.buffer).setUint32(0, key.kid);
  new DataView(aad.buffer).setUint32(4, counter >>> 0);
  const ct = aesGcmEncrypt(key.textKey, nonceFor(key.textSalt, key.kid, counter >>> 0), plaintext, aad);
  return { kid: key.kid, n: counter >>> 0, ct: toB64u(ct) };
}

export function decryptGroup(key: DerivedSenderKey, n: number, ct: string): Uint8Array | null {
  const aad = new Uint8Array(8);
  new DataView(aad.buffer).setUint32(0, key.kid);
  new DataView(aad.buffer).setUint32(4, n >>> 0);
  try {
    return aesGcmDecrypt(key.textKey, nonceFor(key.textSalt, key.kid, n >>> 0), fromB64u(ct), aad);
  } catch {
    return null;
  }
}
