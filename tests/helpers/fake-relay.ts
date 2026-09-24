import type { PeerState, RelayToClient, SignalData } from '@crocodile/protocol';
import {
  Emitter,
  type HostRelayAdapter,
  type RelayHandle,
  type RelayLinkEvents,
  type RelayTransport,
  type TransportFactory,
} from '@crocodile/client-core';

/**
 * In-memory stand-in for WebRTC + HostRelay with the same routing semantics,
 * so client logic (election following, E2EE, history sync) can be tested in
 * Node. The real relay is covered by its own WebRTC tests.
 */
export class FakeRelayNetwork {
  private relays = new Map<string, FakeRelay>();

  adapter(): HostRelayAdapter {
    return {
      start: async (opts) => {
        const relay = new FakeRelay(opts.identity.userId, opts.members);
        const key = `${opts.sessionId}|${opts.epoch}|${opts.identity.userId}`;
        this.relays.set(key, relay);
        return {
          handleSignal: () => {},
          close: async () => {
            this.relays.delete(key);
            relay.close();
          },
        } satisfies RelayHandle;
      },
    };
  }

  transportFactory(): TransportFactory {
    return (opts) =>
      new FakeTransport(this, `${opts.sessionId}|${opts.epoch}|${opts.host}`, opts.identity.userId);
  }

  find(key: string) {
    return this.relays.get(key);
  }

  /** Simulate the host vanishing without a goodbye (crash, network loss). */
  killRelaysOf(userId: string) {
    for (const [key, relay] of this.relays) {
      if (key.endsWith(`|${userId}`)) {
        this.relays.delete(key);
        relay.close();
      }
    }
  }
}

class FakeRelay {
  peers = new Map<string, { t: FakeTransport; state: PeerState }>();
  constructor(
    readonly host: string,
    private readonly members: () => string[],
  ) {}

  attach(t: FakeTransport): boolean {
    if (!this.members().includes(t.userId)) return false;
    const others = [...this.peers.values()];
    this.peers.set(t.userId, { t, state: { userId: t.userId, muted: false, deafened: false } });
    t.deliver({
      t: 'hello',
      you: t.userId,
      host: this.host,
      peers: others.map((o) => o.state),
      slots: 0,
    });
    for (const o of others)
      o.t.deliver({ t: 'peer_join', peer: { userId: t.userId, muted: false, deafened: false } });
    return true;
  }

  detach(userId: string) {
    if (!this.peers.delete(userId)) return;
    for (const o of this.peers.values()) o.t.deliver({ t: 'peer_leave', userId });
  }

  route(from: string, msg: { t: string; to?: string; d?: unknown }) {
    if (msg.t === 'bcast') {
      for (const [id, o] of this.peers)
        if (id !== from) o.t.deliver({ t: 'msg', from, direct: false, d: msg.d });
    } else if (msg.t === 'direct' && msg.to) {
      this.peers.get(msg.to)?.t.deliver({ t: 'msg', from, direct: true, d: msg.d });
    }
  }

  close() {
    for (const o of this.peers.values()) o.t.drop('host went away');
    this.peers.clear();
  }
}

class FakeTransport extends Emitter<RelayLinkEvents> implements RelayTransport {
  private relay?: FakeRelay;
  private closed = false;

  constructor(
    private readonly net: FakeRelayNetwork,
    private readonly key: string,
    readonly userId: string,
  ) {
    super();
  }

  get isOpen() {
    return !!this.relay && !this.closed;
  }

  async connect() {
    // Like a real offer, give the host a moment to learn it was elected.
    for (let i = 0; i < 100 && !this.closed; i++) {
      const relay = this.net.find(this.key);
      if (relay) {
        this.relay = relay;
        setTimeout(() => {
          if (this.closed) return;
          if (!relay.attach(this)) return this.drop('not admitted');
          this.emit('open', undefined);
        }, 5);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!this.closed) this.drop('host relay not found');
  }

  async handleSignal(_data: SignalData) {}

  deliver(msg: RelayToClient) {
    setTimeout(() => !this.closed && this.emit('message', msg), 1);
  }

  send(msg: { t: string }) {
    if (!this.isOpen) return false;
    const relay = this.relay!;
    setTimeout(() => relay.route(this.userId, msg as never), 1);
    return true;
  }

  drop(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.relay?.detach(this.userId);
    this.emit('failed', { reason });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.relay?.detach(this.userId);
    this.emit('closed', undefined);
  }
}
