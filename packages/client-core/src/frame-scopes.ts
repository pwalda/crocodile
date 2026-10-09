import { AudioReceiver, AudioSender, importChain } from '@crocodile/crypto';
import type { FrameKeys } from './keyring';

export interface FrameScope {
  sender: AudioSender | null;
  receivers: Map<number, AudioReceiver>;
}

/**
 * The frame worker's key state, one scope per connection. Scopes share one
 * AudioSender per sender key: a reconnect gets a new scope, and its frames
 * must continue the same counter rather than start over and reuse nonces.
 */
export class FrameScopes {
  readonly scopes = new Map<string, FrameScope>();
  private senders = new Map<number, AudioSender>();

  get(id: string): FrameScope | undefined {
    return this.scopes.get(id);
  }

  update(id: string, keys: FrameKeys) {
    let s = this.scopes.get(id);
    if (!s) this.scopes.set(id, (s = { sender: null, receivers: new Map() }));
    if (keys.mine) {
      const chain = importChain({ gen: keys.mine.gen, key: keys.mine.key });
      let sender = this.senders.get(keys.mine.kid);
      if (!sender) {
        sender = new AudioSender(keys.mine.kid, chain);
        this.senders.set(keys.mine.kid, sender);
      } else sender.update(chain);
      s.sender = sender;
    }
    const next = new Map<number, AudioReceiver>();
    for (const p of keys.peers) {
      const kid = p.kid >>> 0;
      // Keep receivers we already have: they may have ratcheted past the given state.
      next.set(
        kid,
        s.receivers.get(kid) ?? new AudioReceiver(kid, importChain({ gen: p.gen, key: p.key })),
      );
    }
    s.receivers = next;
  }

  drop(id: string) {
    this.scopes.delete(id);
    // Forget senders no scope uses any more (their keys have been replaced).
    const inUse = new Set([...this.scopes.values()].map((s) => s.sender));
    for (const [kid, sender] of this.senders) if (!inUse.has(sender)) this.senders.delete(kid);
  }
}
