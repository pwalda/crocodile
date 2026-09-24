import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity, randomId, signRecord, userTag } from '@crocodile/crypto';
import { recordKey, sessionIds } from '@crocodile/protocol';
import type { Coordinator } from '@crocodile/coordinator';
import {
  caps,
  connectUser,
  createSpace,
  joinSpace,
  lastSession,
  startCoordinator,
  waitFor,
  type TestUser,
} from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

async function user(c: Coordinator, name?: string) {
  const u = await connectUser(c, createIdentity(), name);
  cleanup.push(() => u.conn.close());
  return u;
}

describe('records', () => {
  it('stores profiles, finds users by name#tag and rejects forgeries', async () => {
    const c = await server();
    const alice = await user(c, 'Alice');
    const bob = await user(c, 'bob');
    const tag = userTag(alice.identity.userId);
    const found = await bob.conn.request('users.search', { query: `alice#${tag}` });
    expect(found.profiles.map((p) => p.key)).toEqual([recordKey.profile(alice.identity.userId)]);

    const forged = signRecord(bob.identity, 'profile', recordKey.profile(alice.identity.userId), {
      username: 'alice',
      encKey: bob.identity.encPublicKey,
    });
    const res = await bob.conn.request('records.put', { record: forged });
    expect(res.accepted).toBe(false);
  });

  it('delivers friend requests in real time', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const req = signRecord(alice.identity, 'friends', recordKey.friends(alice.identity.userId), {
      friends: [bob.identity.userId],
      blocked: [],
    });
    expect((await alice.conn.request('records.put', { record: req })).accepted).toBe(true);
    await waitFor(() => bob.events.find((e) => e.ev === 'record'), 2000, 'friend request event');
    const incoming = await bob.conn.request('friends.incoming', {});
    expect(incoming.records.map((r) => r.key)).toEqual([recordKey.friends(alice.identity.userId)]);
  });

  it('lets invited users join spaces', async () => {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const { spaceId, code } = await createSpace(alice);
    await joinSpace(bob, spaceId, code);
    const mine = await bob.conn.request('spaces.mine', {});
    expect(mine.spaces.map((s) => s.key)).toEqual([recordKey.space(spaceId)]);
    const members = await alice.conn.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    expect(members.records).toHaveLength(2);
  });
});

describe('sessions and host election', () => {
  async function setup() {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const carol = await user(c);
    const s = await createSpace(alice);
    await joinSpace(bob, s.spaceId, s.code);
    await joinSpace(carol, s.spaceId, s.code);
    return { c, alice, bob, carol, ...s, sessionId: sessionIds.voice(s.spaceId, s.voiceChannel) };
  }

  it('elects the best-connected member as host and a runner-up as backup', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    await bob.conn.request('session.join', { sessionId, caps: caps({ nat: 'symmetric' }) });
    const { state } = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    // Bob was first and healthy, so he stays host: no flapping when a better peer joins.
    expect(state.host).toBe(bob.conn.peer);
    expect(state.backup).toBe(alice.conn.peer);
    await carol.conn.request('session.join', {
      sessionId,
      caps: caps({ platform: 'web', canHost: false }),
    });
    const seen = await waitFor(() => {
      const st = lastSession(bob, sessionId);
      return st && st.members.length === 3 ? st : null;
    });
    expect(seen.host).toBe(bob.conn.peer);
    expect(seen.backup).toBe(alice.conn.peer);
  });

  it('fails over to the backup when the host disconnects', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    const first = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await carol.conn.request('session.join', { sessionId, caps: caps({ nat: 'symmetric' }) });
    expect(first.state.host).toBe(alice.conn.peer);
    alice.conn.close();
    const st = await waitFor(
      () => {
        const s = lastSession(carol, sessionId);
        return s && s.host === bob.conn.peer ? s : null;
      },
      3000,
      'failover',
    );
    expect(st.epoch).toBe(first.state.epoch + 1);
    expect(st.backup).toBe(carol.conn.peer);
  });

  it('fails over when members report the host unreachable', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    const { state } = await alice.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await carol.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.report', {
      sessionId,
      epoch: state.epoch,
      issue: 'host_unreachable',
    });
    const st = await waitFor(
      () => {
        const s = lastSession(carol, sessionId);
        return s && s.host !== alice.conn.peer ? s : null;
      },
      3000,
      'report failover',
    );
    expect(st.host).toBe(bob.conn.peer);
    expect(st.members).toHaveLength(3);
  });

  it('routes signalling only between session members and rejects outsiders', async () => {
    const { c, alice, bob, sessionId } = await setup();
    const outsider = await user(c);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    const data = { type: 'bye' as const, epoch: 1, dir: 'toRelay' as const };
    const r = await bob.conn.request('signal.send', { to: alice.conn.peer, sessionId, data });
    expect(r.delivered).toBe(true);
    await waitFor(() => alice.events.find((e) => e.ev === 'signal'));
    await expect(
      outsider.conn.request('session.join', { sessionId, caps: caps() }),
    ).rejects.toThrow(/not a member/);
    await expect(
      outsider.conn.request('signal.send', { to: alice.conn.peer, sessionId, data }),
    ).rejects.toThrow(/join the session/);
  });

  it('publishes voice channel occupancy to watchers', async () => {
    const { alice, bob, spaceId, voiceChannel, sessionId } = await setup();
    const snap = await bob.conn.request('voice.watch', { spaceIds: [spaceId] });
    expect(snap.voice).toEqual([]);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    const ev = await waitFor(() => bob.events.find((e) => e.ev === 'voice'));
    expect(ev.d).toMatchObject({
      spaceId,
      channelId: voiceChannel,
      members: [alice.identity.userId],
    });
  });
});

describe('coordination mesh', () => {
  async function mesh() {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(
      () => a.mesh.peerIds().length === 1 && b.mesh.peerIds().length === 1,
      5000,
      'mesh link',
    );
    return { a, b };
  }

  it('replicates records and presence across servers', async () => {
    const { a, b } = await mesh();
    const alice = await user(a, 'alice');
    const bob = await user(b, 'bob');
    await waitFor(
      () => b.records.get(recordKey.profile(alice.identity.userId)),
      3000,
      'replication',
    );
    const found = await bob.conn.request('users.search', { query: 'alice' });
    expect(found.profiles).toHaveLength(1);
    const { presence } = await bob.conn.request('presence.subscribe', {
      userIds: [alice.identity.userId],
    });
    expect(presence[0]?.status).toBe('online');
    alice.conn.close();
    await waitFor(
      () =>
        bob.events.find(
          (e) => e.ev === 'presence' && (e.d as { status: string }).status === 'offline',
        ),
      3000,
      'offline',
    );
  });

  it('catches up on records written while a server was offline', async () => {
    const a = await server({ name: 'A' });
    const alice = await user(a, 'alice');
    const s = await createSpace(alice);
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'backlog sync');
    expect(b.isSpaceMember(s.spaceId, alice.identity.userId)).toBe(true);
  });

  it('runs sessions across servers and keeps the host when the owner server dies', async () => {
    const { a, b } = await mesh();
    const alice = await user(a);
    const bob = await user(b);
    const s = await createSpace(alice);
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'invite replicated');
    await joinSpace(bob, s.spaceId, s.code);
    await waitFor(() => a.isSpaceMember(s.spaceId, bob.identity.userId), 3000, 'member replicated');

    // Pick a session id owned by whichever server we will keep alive, then kill the owner.
    const sessionId = `voice:${s.spaceId}:${s.voiceChannel}`;
    const r1 = await alice.conn.request('session.join', { sessionId, caps: caps({ nat: 'open' }) });
    const r2 = await bob.conn.request('session.join', { sessionId, caps: caps() });
    expect(r2.state.host).toBe(alice.conn.peer);
    expect(r2.state.id).toBe(r1.state.id);

    const sig = await bob.conn.request('signal.send', {
      to: alice.conn.peer,
      sessionId,
      data: { type: 'bye', epoch: 1, dir: 'toRelay' },
    });
    expect(sig.delivered).toBe(true);

    const owner = a.sessions.ownerOf(sessionId) === a.info.id ? a : b;
    const survivor = owner === a ? b : a;
    const survivingUser: TestUser = owner === a ? bob : alice;
    if (owner === b) {
      // Bob's server owns it; killing B disconnects Bob, so Alice alone remains, still host.
      await b.stop();
      const st = await waitFor(
        () => {
          const x = survivor.sessions.ownedState(sessionId);
          return x && x.members.length === 1 ? x : null;
        },
        5000,
        'rebuild',
      );
      expect(st.host).toBe(alice.conn.peer);
      expect(st.epoch).toBe(r2.state.epoch);
    } else {
      // Alice's server owns it and Alice is host: killing A drops Alice, Bob takes over.
      await a.stop();
      const st = await waitFor(
        () => {
          const x = survivor.sessions.ownedState(sessionId);
          return x && x.host === bob.conn.peer ? x : null;
        },
        5000,
        'takeover',
      );
      expect(st.members.map((m) => m.peer)).toEqual([survivingUser.conn.peer]);
    }
  });

  it('keeps the host when only its coordination server dies and it reconnects elsewhere', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    const c = await server({ name: 'C', meshPeers: [a.url, b.url] });
    await waitFor(() => [a, b, c].every((x) => x.mesh.peerIds().length === 2), 5000, 'full mesh');

    const owner = await user(a);
    const s = await createSpace(owner);
    // Find a voice session owned by A (rendezvous hashing picks the owner).
    let sessionId = `voice:${s.spaceId}:${s.voiceChannel}`;
    const channels = [...s.space.body.channels];
    for (let i = 0; a.sessions.ownerOf(sessionId) !== a.info.id && i < 50; i++) {
      const id = randomId();
      channels.push({ id, name: `v${i}`, kind: 'voice' });
      sessionId = `voice:${s.spaceId}:${id}`;
    }
    await owner.conn.request('records.put', {
      record: signRecord(
        owner.identity,
        'space',
        `space:${s.spaceId}`,
        { ...s.space.body, channels },
        Date.now() + 1,
      ),
    });
    expect(a.sessions.ownerOf(sessionId)).toBe(a.info.id);

    const hostId = createIdentity();
    await waitFor(() => b.records.get(`invite:${s.code}`), 3000, 'replicated');
    const host = await connectUser(b, hostId, 'host', 'hostdevicex');
    cleanup.push(() => host.conn.close());
    await joinSpace(host, s.spaceId, s.code);
    await waitFor(() => a.isSpaceMember(s.spaceId, hostId.userId), 3000);
    const first = await host.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    await owner.conn.request('session.join', { sessionId, caps: caps({ nat: 'symmetric' }) });
    expect(first.state.host).toBe(host.conn.peer);

    // B dies; the host's app fails over to C and re-joins with the same identity.
    await b.stop();
    const again = await connectUser(c, hostId, 'host', 'hostdevicex');
    cleanup.push(() => again.conn.close());
    await waitFor(() => c.isSpaceMember(s.spaceId, hostId.userId), 3000, 'membership on C');
    const rejoined = await again.conn.request('session.join', {
      sessionId,
      caps: caps({ nat: 'open' }),
    });
    expect(rejoined.state.host).toBe(host.conn.peer);
    expect(rejoined.state.epoch).toBe(first.state.epoch);
  });
});

describe('opt-in server relay', () => {
  it('issues time-limited grants to session members, capped per server', async () => {
    const c = await server({ relay: { enabled: true, maxUsers: 1 }, stunPort: 0 });
    const alice = await user(c);
    const bob = await user(c);
    const outsider = await user(c);
    const s = await createSpace(alice);
    await joinSpace(bob, s.spaceId, s.code);
    const sessionId = `space:${s.spaceId}`;
    await expect(alice.conn.request('relay.request', { sessionId })).rejects.toThrow(
      /join the session/,
    );
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.join', { sessionId, caps: caps() });

    const { grant } = await alice.conn.request('relay.request', { sessionId });
    expect(grant.urls[0]).toMatch(/^turn:/);
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(grant.expiresAt - Date.now()).toBeGreaterThan(59 * 60_000);
    // Asking again does not extend the window.
    const again = await alice.conn.request('relay.request', { sessionId });
    expect(again.grant.expiresAt).toBe(grant.expiresAt);
    // Capacity: one user at a time on this server.
    await expect(bob.conn.request('relay.request', { sessionId })).rejects.toThrow(/capacity/);
    await expect(outsider.conn.request('relay.request', { sessionId })).rejects.toThrow();
    await alice.conn.request('relay.release', {});
    const forBob = await bob.conn.request('relay.request', { sessionId });
    expect(forBob.grant.username).toContain(bob.identity.userId);
  });

  it('ends grants after the window and tells the user', async () => {
    const c = await server({ stunPort: 0 });
    c.turn!.limits.maxGrantMs = 300;
    const alice = await user(c);
    const s = await createSpace(alice);
    const sessionId = `space:${s.spaceId}`;
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await alice.conn.request('relay.request', { sessionId });
    await waitFor(() => alice.events.find((e) => e.ev === 'relay_expired'), 3000, 'expiry event');
    expect(c.relayStats().activeUsers).toBe(0);
  });
});

describe('encrypted client channel', () => {
  it('refuses plaintext requests after authentication', async () => {
    const c = await server();
    const alice = await user(c);
    // Reach into the raw socket: a plaintext frame must kill the connection.
    const raw = (alice.conn as unknown as { ws: WebSocket }).ws;
    const closed = new Promise<number>((r) => raw.addEventListener('close', (e) => r(e.code)));
    raw.send(JSON.stringify({ t: 'req', id: 99, m: 'servers.list', p: {} }));
    expect(await closed).toBe(1008);
  });
});
