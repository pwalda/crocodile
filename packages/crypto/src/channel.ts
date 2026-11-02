import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { concatBytes, fromB64u, toB64u, utf8 } from '@crocodile/protocol';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, randomBytes, x25519 } from './primitives';
import { pad, unpad } from './padding';

/**
 * Encrypted, length-padded frames over an existing WebSocket. Used between
 * clients and coordination servers and between servers in the mesh, so
 * what is said stays confidential even over plain ws:// to home-hosted
 * servers. A client's sign-in is sealed too; a server's own id is not (the
 * hello, and a server's identification to another server).
 *
 * Key agreement is hybrid (X25519 + ML-KEM-768) with fresh keys per
 * connection on both sides (forward secret); the handshake messages are
 * signed with the parties' identity keys by the caller.
 */
export interface ChannelKeys {
  x25519Secret: Uint8Array;
  mlkemSecret: Uint8Array;
  offer: { x25519: string; mlkem: string };
}

export function createChannelKeys(): ChannelKeys {
  const xs = randomBytes(32);
  const kem = ml_kem768.keygen(randomBytes(64));
  return {
    x25519Secret: xs,
    mlkemSecret: kem.secretKey,
    offer: { x25519: toB64u(x25519.getPublicKey(xs)), mlkem: toB64u(kem.publicKey) },
  };
}

/** Responder side: answer an offer with an ephemeral X25519 key and a KEM ciphertext. */
export function answerChannel(offer: { x25519: string; mlkem: string }) {
  const eph = randomBytes(32);
  const epk = x25519.getPublicKey(eph);
  const ssX = x25519.getSharedSecret(eph, fromB64u(offer.x25519));
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromB64u(offer.mlkem));
  return {
    answer: { epk: toB64u(epk), kem: toB64u(cipherText) },
    secret: concatBytes(ssX, sharedSecret),
  };
}

/** Offer side: recover the shared secret from an answer. */
export function acceptChannel(keys: ChannelKeys, answer: { epk: string; kem: string }): Uint8Array {
  const ssX = x25519.getSharedSecret(keys.x25519Secret, fromB64u(answer.epk));
  const ssKem = ml_kem768.decapsulate(fromB64u(answer.kem), keys.mlkemSecret);
  return concatBytes(ssX, ssKem);
}

/**
 * What the channel that carries a client's sign-in is bound to. It is apart from the channel for
 * the rest of the connection, which also names the client (known only once the sign-in is open).
 */
export const signInChannelContext = (challenge: string, serverId: string) =>
  `${challenge}|${serverId}|auth`;

/**
 * The number of a frame `seal` made, read from the first bytes of its text without decoding it
 * (for a frame that is dropped unread). Undefined if the text does not begin as `seal` writes one.
 */
export function peekFrameNumber(head: string): number | undefined {
  const n = /^\{"t":"x","n":(\d{1,15}),/.exec(head.slice(0, 40))?.[1];
  return n === undefined ? undefined : Number(n);
}

export class SecureChannel {
  private sendN = 0;
  private recvN = -1;
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;

  /**
   * @param secret shared secret from the handshake
   * @param context transcript binding (e.g. challenge and both ids)
   * @param initiator which direction's key we send with
   */
  constructor(secret: Uint8Array, context: string, initiator: boolean) {
    const okm = hkdfSha256(secret, utf8.encode(context), 'croc/v1/channel', 64);
    const a = okm.slice(0, 32);
    const b = okm.slice(32, 64);
    this.sendKey = initiator ? a : b;
    this.recvKey = initiator ? b : a;
  }

  private static nonce(n: number) {
    const nonce = new Uint8Array(12);
    const v = new DataView(nonce.buffer);
    v.setUint32(4, Math.floor(n / 2 ** 32));
    v.setUint32(8, n >>> 0);
    return nonce;
  }

  seal(value: unknown): { t: 'x'; n: number; c: string } {
    const n = this.sendN;
    const ct = aesGcmEncrypt(
      this.sendKey,
      SecureChannel.nonce(n),
      pad(utf8.encode(JSON.stringify(value))),
    );
    // (Taken only once there is a frame, so one that cannot be made leaves no gap.)
    this.sendN = n + 1;
    return { t: 'x', n, c: toB64u(ct) };
  }

  /**
   * Passes over a frame that is dropped unread, as one a rate limit refuses, so that the next one
   * still follows it. Nothing is checked of it: only the place it holds moves on. False if the
   * frame is not the next, which is a gap nothing can close.
   */
  skip(n: number): boolean {
    if (n !== this.recvN + 1) return false;
    this.recvN = n;
    return true;
  }

  /**
   * Returns the decoded value, or undefined for a forged, replayed or out of order frame. A
   * WebSocket delivers in order, so each frame is the one after the last: a missing one means a
   * frame was held back or dropped, and nothing after it is taken.
   */
  open(frame: { n: number; c: string }): unknown {
    if (frame.n !== this.recvN + 1) return undefined;
    let bytes: Uint8Array | null;
    try {
      bytes = aesGcmDecrypt(this.recvKey, SecureChannel.nonce(frame.n), fromB64u(frame.c));
    } catch {
      return undefined;
    }
    const plain = bytes && unpad(bytes);
    if (!plain) return undefined;
    this.recvN = frame.n;
    try {
      return JSON.parse(utf8.decode(plain));
    } catch {
      return undefined;
    }
  }
}
