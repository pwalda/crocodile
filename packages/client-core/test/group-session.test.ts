import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity } from '@crocodile/crypto';
import { GroupKeyring } from '../src/keyring';
import type { RelayGrant, SealedBox, SessionState } from '@crocodile/protocol';
import { Emitter } from '../src/emitter';
import {
  GroupSession,
  type RelayTransport,
  type SessionContext,
  type TransportFactory,
} from '../src/group-session';
import type { RelayLinkEvents } from '../src/relay-link';

const waitFor = async (fn: () => boolean, ms = 2000) => {
  for (const start = Date.now(); !fn();) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A connection that never gets anywhere: the session decides what happens to it. */
class StuckTransport extends Emitter<RelayLinkEvents> implements RelayTransport {
  closed = false;
  readonly isOpen: boolean = false;
  async connect() {
    this.emit('progress', { step: 'offer' });
  }
  async handleSignal() {}
  send(_msg?: unknown) {
    return false;
  }
  close() {
    this.closed = true;
  }
}

/** A box that opens to its text for anyone: `epk` carries who sent it, `ct` what it holds. */
const box = (from: string, to: string, text: string): SealedBox => ({
  v: 3,
  to,
  pk: 0,
  epk: from,
  kem: '',
  ct: text,
  from: '',
  fromDevice: 'aaaaaaaa',
  sig: '',
});

/** A connection that is up: it keeps what the session sends over it. */
class OpenTransport extends StuckTransport {
  override readonly isOpen = true;
  readonly requests: { to: string; type: string; since?: Record<string, number> }[] = [];
  constructor(private readonly sent: string[]) {
    super();
  }
  override send(msg: unknown) {
    const m = msg as { to?: string; d?: { k?: string; box?: SealedBox } };
    if (m.d?.k === 'sealed') {
      const payload = JSON.parse(m.d.box!.ct) as { type: string; since?: Record<string, number> };
      this.sent.push(payload.type);
      this.requests.push({ to: m.to!, type: payload.type, since: payload.since });
    }
    return true;
  }
}

const me = 'aaaaaaaaaaaaaaaaaaaaaaaaaa.dev1';
const sessions: GroupSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.leave();
});

function session(
  relayRequest: () => Promise<RelayGrant>,
  request: (type: string) => Promise<unknown> = async () => ({}),
) {
  const transports: StuckTransport[] = [];
  const factory: TransportFactory = () => {
    const t = new StuckTransport();
    transports.push(t);
    return t;
  };
  const ctx = {
    identity: createIdentity(),
    peer: me,
    link: () => ({ request }),
    caps: async () => ({}),
    platform: {},
    iceServers: () => [],
    relay: { allowed: () => true, request: relayRequest },
    isMemberPeer: () => true,
    isAllowedPeer: () => true,
    hasDevice: () => true,
    refreshPeer: async () => {},
    log: () => {},
  } as unknown as SessionContext;
  const s = new GroupSession('dm:a:b', ctx, factory);
  sessions.push(s);
  return { s, transports };
}

const state = (host: string, epoch: number): SessionState => ({
  id: 'dm:a:b',
  epoch,
  host,
  backup: null,
  members: [],
  relaySlots: 0,
  updatedAt: 0,
});

const grant = (ms: number): RelayGrant => ({
  urls: ['turn:example.org:7443?transport=udp'],
  username: 'u',
  credential: 'c',
  expiresAt: Date.now() + ms,
  server: 'Test',
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('group session', () => {
  it('ends an attempt the session moved on from, instead of leaving it "trying"', () => {
    const { s, transports } = session(async () => grant(60_000));
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    // The host changes before the first attempt got anywhere.
    s.applyState(state('cccccccccccccccccccccccccc.dev1', 2));
    expect(transports[0]!.closed).toBe(true);
    expect(s.attempts).toHaveLength(2);
    expect(s.attempts[0]!.end).toMatchObject({ ok: false, stage: 'superseded' });
    expect(s.attempts[1]!.end).toBeUndefined();
  });

  /** A server that refuses a relay until it has seen the join, and counts the joins. */
  function joinFirst() {
    const sent: string[] = [];
    let joined = false;
    const made = session(
      async () => {
        if (!joined) throw new Error('join the session first');
        return grant(60_000);
      },
      async (type) => {
        sent.push(type);
        if (type !== 'session.join') return {};
        await wait(20);
        joined = true;
        return { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) };
      },
    );
    return { ...made, joins: () => sent.filter((t) => t === 'session.join').length };
  }

  it('signs a new join when the server asks for one, and not for a session it has left', async () => {
    const { s, joins } = joinFirst();
    await s.join();
    expect(joins()).toBe(1);
    // The server that keeps the session changed: a join of its own, on top of one in flight too.
    await s.renew();
    expect(joins()).toBe(2);
    await s.leave();
    await s.renew();
    expect(joins()).toBe(2);
  });

  it('joins again when the server says an update or a report is not for the join it has', async () => {
    const sent: string[] = [];
    let said = false;
    const { s } = session(
      async () => grant(60_000),
      async (type) => {
        sent.push(type);
        if (type === 'session.update' && !said) {
          said = true;
          throw Object.assign(new Error('that is not the join'), { code: 'conflict' });
        }
        return type === 'session.join'
          ? { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) }
          : {};
      },
    );
    await s.join();
    await s.updateCaps();
    await wait(50);
    expect(sent.filter((t) => t === 'session.join')).toHaveLength(2);
    // Not for any other kind of failure.
    await s.updateCaps();
    await wait(50);
    expect(sent.filter((t) => t === 'session.join')).toHaveLength(2);
  });

  it('does not start a join for every update that finds it is not in the room', async () => {
    const sent: string[] = [];
    const { s } = session(
      async () => grant(60_000),
      async (type) => {
        sent.push(type);
        if (type === 'session.update')
          throw Object.assign(new Error('not in session'), { code: 'not_found' });
        return type === 'session.join'
          ? { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) }
          : {};
      },
    );
    await s.join();
    await s.updateCaps();
    await s.updateCaps();
    await s.updateCaps();
    await wait(50);
    expect(sent.filter((t) => t === 'session.join')).toHaveLength(2);
  });

  it('joins again, more than once if it must, when taken out of the room', async () => {
    let joins = 0;
    const { s } = session(
      async () => grant(60_000),
      async (type) => {
        if (type !== 'session.join') return {};
        if (++joins < 3) throw new Error('the owner cannot be reached');
        return { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) };
      },
    );
    await s.rejoin();
    expect(joins).toBe(3);
    await s.leave();
    await s.rejoin();
    expect(joins).toBe(3);
  });

  it('joins the session first when asked for a relay before it has', async () => {
    const { s, joins } = joinFirst();
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
    expect(joins()).toBe(1);
  });

  it('shares a join that is already under way, and does not join again once joined', async () => {
    const { s, joins } = joinFirst();
    const joining = s.join();
    await s.useServerRelay();
    await joining;
    expect(s.relayGrant).not.toBeNull();
    expect(joins()).toBe(1);
    await s.useServerRelay();
    expect(joins()).toBe(1);
  });

  it('does not bring back a session that was left', async () => {
    const { s, joins } = joinFirst();
    await s.leave();
    await s.useServerRelay();
    expect(s.relayGrant).toBeNull();
    expect(joins()).toBe(0);
  });

  it('does not take a relay for a joined session that was left', async () => {
    const { s } = joinFirst();
    await s.join();
    await s.leave();
    await s.useServerRelay();
    expect(s.relayGrant).toBeNull();
  });

  it('sends its own join after a leave instead of sharing the one already under way', async () => {
    const { s, joins } = joinFirst();
    const before = s.join();
    await wait(5);
    await s.leave();
    const after = s.join();
    await Promise.all([before, after]);
    expect(joins()).toBe(2);
    expect(s.relayGrant).toBeNull();
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
  });

  it('does not keep a grant that arrives after the session was left', async () => {
    const { s } = session(async () => {
      await wait(30);
      return grant(60_000);
    });
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    const asking = s.useServerRelay();
    await s.leave();
    await asking;
    expect(s.relayGrant).toBeNull();
  });

  it('sends a join on a new connection even while one sent on the old one is in flight', async () => {
    const { s, joins } = joinFirst();
    const old = s.join();
    await Promise.all([old, s.join({ fresh: true })]);
    expect(joins()).toBe(2);
  });

  it('lets every caller see a failed join, and sends the next one anew', async () => {
    let joins = 0;
    const { s } = session(
      async () => grant(60_000),
      async (type) => {
        if (type !== 'session.join') return {};
        if (joins++ > 0) return { state: state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1) };
        await wait(10);
        throw new Error('link down');
      },
    );
    const results = await Promise.allSettled([s.join(), s.join()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(joins).toBe(1);
    await s.join();
    expect(joins).toBe(2);
  });

  it('sends no join for a session that was left before it went out', async () => {
    const { s, joins } = joinFirst();
    const joining = s.join();
    await s.leave();
    await joining;
    expect(joins()).toBe(0);
  });

  it('waits for a join under way on a new connection before asking for a relay', async () => {
    const { s, joins } = joinFirst();
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    void s.join({ fresh: true });
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
    expect(joins()).toBe(1);
  });

  it('does not take a relay when it was left while joining', async () => {
    const { s } = joinFirst();
    const asking = s.useServerRelay();
    await s.leave();
    await asking;
    expect(s.relayGrant).toBeNull();
  });

  it('tries a failed relay renewal again before the grant runs out', async () => {
    const answers = [grant(600), 'fail', grant(60_000)] as const;
    let asked = 0;
    const { s } = session(async () => {
      const a = answers[Math.min(asked++, answers.length - 1)]!;
      if (a === 'fail') throw new Error('link down');
      return a;
    });
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    await s.useServerRelay();
    const first = s.relayGrant!.expiresAt;
    await wait(700);
    expect(asked).toBe(3);
    expect(s.relayGrant!.expiresAt).toBeGreaterThan(first);
  });

  it('drops a grant at its end even when the server never says so', async () => {
    let asked = 0;
    const { s, transports } = session(async () => {
      if (asked++ === 0) return grant(400);
      throw new Error('link down');
    });
    s.applyState(state('bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1', 1));
    await s.useServerRelay();
    expect(s.relayGrant).not.toBeNull();
    const before = transports.length;
    await wait(600);
    expect(s.relayGrant).toBeNull();
    // The connection, which depended on the relay, was set up again without it.
    expect(transports.length).toBe(before + 1);
  });

  describe('who the relay we host admits', () => {
    const bob = 'bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1';
    async function admitted(sessionId: string) {
      let members: (() => string[]) | undefined;
      const ctx = {
        identity: createIdentity(),
        peer: me,
        link: () => ({ request: async () => ({}) }),
        platform: {
          relay: {
            start: async (opts: { members: () => string[] }) => {
              members = opts.members;
              return { handleSignal() {}, close() {} };
            },
          },
        },
        iceServers: () => [],
        relay: { allowed: () => false, request: async () => grant(1000) },
        // Bob belongs but we have blocked him.
        isMemberPeer: () => true,
        hasDevice: () => true,
        isAllowedPeer: (_: string, peer: string) => peer !== bob,
        refreshPeer: async () => {},
        log: () => {},
      } as unknown as SessionContext;
      const s = new GroupSession(sessionId, ctx, () => new StuckTransport());
      sessions.push(s);
      const caps = { nat: 'open' as const, canHost: true };
      s.applyState({
        ...state(me, 1),
        id: sessionId,
        members: [
          { peer: me, caps },
          { peer: bob, caps },
        ],
      } as unknown as SessionState);
      await wait(20);
      return members!();
    }

    it('in a direct conversation, not the one we blocked', async () => {
      expect(await admitted('dm:a:b')).toEqual([me]);
    });

    it('in a space, a blocked member too: the others are relayed to them', async () => {
      expect(await admitted('space:abc')).toEqual([me, bob]);
    });
  });

  it('does not connect to the other side of a direct conversation that we blocked', async () => {
    const bob = 'bbbbbbbbbbbbbbbbbbbbbbbbbb.dev1';
    const transports: StuckTransport[] = [];
    const requests: string[] = [];
    const ctx = {
      identity: createIdentity(),
      peer: me,
      link: () => ({
        request: async (m: string) => {
          requests.push(m);
          return {};
        },
      }),
      platform: {},
      iceServers: () => [],
      relay: { allowed: () => false, request: async () => grant(1000) },
      isMemberPeer: () => true,
      hasDevice: () => true,
      isAllowedPeer: () => false,
      refreshPeer: async () => {},
      log: () => {},
    } as unknown as SessionContext;
    const s = new GroupSession('dm:a:b', ctx, () => {
      const t = new StuckTransport();
      transports.push(t);
      return t;
    });
    sessions.push(s);
    s.applyState(state(bob, 1));
    await wait(20);
    expect(transports).toHaveLength(0);
    expect(s.status).toBe('reconnecting');
    // The server knows nothing of blocks, so it is not told.
    expect(requests).not.toContain('session.report');
  });

  it('asks for history again when a live message could not be opened by the key that came after it', async () => {
    const self = 'aaaaaaaaaaaaaaaaaaaaaaaaaa.deviceaa';
    const bob = 'bbbbbbbbbbbbbbbbbbbbbbbbbb.devicebb';
    const host = 'cccccccccccccccccccccccccc.devicecc';
    const sent: string[] = [];
    let transport: OpenTransport | undefined;
    const enc = new TextEncoder();
    const ctx = {
      identity: createIdentity(),
      peer: self,
      link: () => ({ request: async () => ({}) }),
      platform: {},
      iceServers: () => [],
      relay: { allowed: () => false, request: async () => grant(1000) },
      isMemberPeer: () => true,
      isAllowedPeer: () => true,
      hasDevice: () => true,
      refreshPeer: async () => {},
      historyChannels: () => ['ch'],
      // A newer message than the one that will be missed is already held.
      syncCursor: async () => 500_000,
      outbox: { pending: () => [], acked: () => {} },
      acceptMessage: async () => true,
      admits: () => true,
      seal: async (to: string, plaintext: Uint8Array) =>
        box(self, to, new TextDecoder().decode(plaintext)),
      open: (b: SealedBox) => ({ from: b.epk, plaintext: enc.encode(b.ct) }),
      log: () => {},
    } as unknown as SessionContext;
    const s = new GroupSession('dm:a:b', ctx, () => (transport = new OpenTransport(sent)));
    sessions.push(s);
    s.applyState(state(host, 1));
    await wait(20);
    const peer = (id: string) => ({ id, muted: false, deafened: false });
    transport!.emit('message', {
      t: 'hello',
      you: self,
      host,
      peers: [peer(host), peer(bob)],
      slots: 0,
    });
    await wait(20);
    const asked = () => sent.filter((t) => t === 'history_req').length;
    expect(asked()).toBe(2);

    // Bob sends before his key reaches us; the key then comes, a step further on.
    const theirs = new GroupKeyring({ autoRatchet: false });
    const env = theirs.encrypt(enc.encode(JSON.stringify({ type: 'typing', ch: 'ch' })));
    transport!.emit('message', { t: 'msg', from: bob, direct: false, d: { k: 'group', ...env } });
    await wait(10);
    const key = {
      type: 'sender_key',
      sessionId: 'dm:a:b',
      to: self,
      at: Date.now(),
      ...theirs.exportMine(),
    };
    transport!.emit('message', {
      t: 'msg',
      from: bob,
      direct: true,
      d: { k: 'sealed', box: box(bob, self, JSON.stringify(key)) },
    });
    await waitFor(() => asked() > 2);
    // The sender is asked first, from before the newest message held.
    const again = transport!.requests.filter((r) => r.type === 'history_req').slice(2);
    expect(again[0]).toMatchObject({ to: bob, since: { ch: 500_000 - 120_000 } });
    expect(asked()).toBe(3);
    // Bob's key replayed by someone else is not a message of theirs that was missed.
    const before = asked();
    transport!.emit('message', { t: 'msg', from: host, direct: false, d: { k: 'group', ...env } });
    await wait(50);
    expect(asked()).toBe(before);
    // Another one he cannot open soon after does not ask again.
    transport!.emit('message', { t: 'msg', from: bob, direct: false, d: { k: 'group', ...env } });
    await wait(50);
    expect(asked()).toBe(before);
  });

  it('does not connect to a host that has no device record, and tells the server', async () => {
    const host = 'cccccccccccccccccccccccccc.devicecc';
    const transports: StuckTransport[] = [];
    const requests: string[] = [];
    const ctx = {
      identity: createIdentity(),
      peer: me,
      link: () => ({
        request: async (m: string) => {
          requests.push(m);
          return {};
        },
      }),
      platform: {},
      iceServers: () => [],
      relay: { allowed: () => false, request: async () => grant(1000) },
      isMemberPeer: () => true,
      isAllowedPeer: () => true,
      hasDevice: () => false,
      refreshPeer: async () => {},
      log: () => {},
    } as unknown as SessionContext;
    const s = new GroupSession('dm:a:b', ctx, () => {
      const t = new StuckTransport();
      transports.push(t);
      return t;
    });
    sessions.push(s);
    s.applyState(state(host, 1));
    await wait(20);
    expect(transports).toHaveLength(0);
    expect(s.status).toBe('reconnecting');
    expect(requests).toContain('session.report');
  });

  it('stops hearing a peer at once when their key is only in its grace period', () => {
    const alice = new GroupKeyring({ autoRatchet: false });
    const bob = new GroupKeyring({ autoRatchet: false });
    bob.addPeerKey('alice.d1', alice.exportMine());
    bob.peerLeft('alice.d1');
    expect(bob.hasKeyFrom('alice.d1')).toBe(false);
    expect(bob.peersWithKeys()).toEqual(['alice.d1']);
    let latest = bob.frameKeys();
    bob.on('changed', (k) => (latest = k));
    bob.forgetPeer('alice.d1');
    expect(latest.peers).toEqual([]);
    expect(bob.peersWithKeys()).toEqual([]);
  });
});
