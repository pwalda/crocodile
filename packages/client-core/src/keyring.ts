import {
  createSenderKey,
  decryptGroup,
  deriveSenderKey,
  encryptGroup,
  exportSenderKey,
  importSenderKey,
  type DerivedSenderKey,
  type SenderKey,
} from '@crocodile/crypto';
import { Emitter } from './emitter';

interface PeerKey {
  userId: string;
  derived: DerivedSenderKey;
  secret: SenderKey;
  /** Epoch ms after which the key is dropped (set when superseded or the peer left). */
  expiresAt: number | null;
}

/** Snapshot handed to the voice frame worker. */
export interface FrameKeys {
  mine: { kid: number; secret: string } | null;
  peers: { kid: number; userId: string; secret: string }[];
}

const GRACE_MS = 10_000;

/**
 * Sender keys for one session: our own (rotated whenever someone leaves, so a
 * departed member cannot decrypt what follows) and the keys other members
 * sealed to us.
 */
export class GroupKeyring extends Emitter<{ changed: FrameKeys; rotated: SenderKey }> {
  private mine: { key: SenderKey; derived: DerivedSenderKey; counter: number };
  private peers = new Map<number, PeerKey>();

  constructor() {
    super();
    const key = createSenderKey();
    this.mine = { key, derived: deriveSenderKey(key), counter: 0 };
  }

  get myKey(): SenderKey {
    return this.mine.key;
  }

  exportMine() {
    return { kid: this.mine.key.kid, key: exportSenderKey(this.mine.key) };
  }

  rotate(): SenderKey {
    const key = createSenderKey();
    this.mine = { key, derived: deriveSenderKey(key), counter: 0 };
    this.emit('rotated', key);
    this.emitChanged();
    return key;
  }

  addPeerKey(userId: string, kid: number, secret: string) {
    const existing = this.peers.get(kid);
    if (existing && existing.userId !== userId) return false;
    const sk = importSenderKey(kid, secret);
    const now = Date.now();
    // A newer key from the same peer supersedes older ones after a grace period.
    for (const p of this.peers.values()) {
      if (p.userId === userId && p.derived.kid !== kid && p.expiresAt === null)
        p.expiresAt = now + GRACE_MS;
    }
    this.peers.set(kid, { userId, secret: sk, derived: deriveSenderKey(sk), expiresAt: null });
    this.emitChanged();
    return true;
  }

  hasKeyFrom(userId: string) {
    for (const p of this.peers.values())
      if (p.userId === userId && p.expiresAt === null) return true;
    return false;
  }

  peerLeft(userId: string) {
    const at = Date.now() + GRACE_MS;
    for (const p of this.peers.values())
      if (p.userId === userId && p.expiresAt === null) p.expiresAt = at;
  }

  encrypt(plaintext: Uint8Array) {
    return encryptGroup(this.mine.derived, this.mine.counter++, plaintext);
  }

  decrypt(kid: number, n: number, ct: string): { userId: string; plaintext: Uint8Array } | null {
    this.prune();
    const peer = this.peers.get(kid >>> 0);
    if (!peer) return null;
    const plaintext = decryptGroup(peer.derived, n, ct);
    return plaintext ? { userId: peer.userId, plaintext } : null;
  }

  frameKeys(): FrameKeys {
    this.prune();
    return {
      mine: { kid: this.mine.key.kid, secret: exportSenderKey(this.mine.key) },
      peers: [...this.peers.values()].map((p) => ({
        kid: p.derived.kid,
        userId: p.userId,
        secret: exportSenderKey(p.secret),
      })),
    };
  }

  private prune() {
    const now = Date.now();
    let changed = false;
    for (const [kid, p] of this.peers) {
      if (p.expiresAt !== null && p.expiresAt < now) {
        this.peers.delete(kid);
        changed = true;
      }
    }
    if (changed) this.emitChanged();
  }

  private emitChanged() {
    this.emit('changed', this.frameKeys());
  }
}
