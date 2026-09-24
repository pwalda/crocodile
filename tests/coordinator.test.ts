import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity, signRecord, userTag } from '@crocodile/crypto';
import { recordKey, sessionIds } from '@crocodile/protocol';
import type { Coordinator } from '@crocodile/coordinator';
import { caps, connectUser, createSpace, joinSpace, lastSession, startCoordinator, waitFor, type TestUser } from './helpers';

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
    const members = await alice.conn.request('records.list', { prefix: recordKey.memberPrefix(spaceId) });
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
    const { state } = await alice.conn.request('session.join', { sessionId, caps: caps({ nat: 'open' }) });
    // Bob was first and healthy, so he stays host: no flapping when a better peer joins.
    expect(state.host).toBe(bob.identity.userId);
    expect(state.backup).toBe(alice.identity.userId);
    await carol.conn.request('session.join', { sessionId, caps: caps({ platform: 'web', canHost: false }) });
    const seen = await waitFor(() => {
      const st = lastSession(bob, sessionId);
      return st && st.members.length === 3 ? st : null;
    });
    expect(seen.host).toBe(bob.identity.userId);
    expect(seen.backup).toBe(alice.identity.userId);
  });

  it('fails over to the backup when the host disconnects', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    const first = await alice.conn.request('session.join', { sessionId, caps: caps({ nat: 'open' }) });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await carol.conn.request('session.join', { sessionId, caps: caps({ nat: 'symmetric' }) });
    expect(first.state.host).toBe(alice.identity.userId);
    alice.conn.close();
    const st = await waitFor(() => {
      const s = lastSession(carol, sessionId);
      return s && s.host === bob.identity.userId ? s : null;
    }, 3000, 'failover');
    expect(st.epoch).toBe(first.state.epoch + 1);
    expect(st.backup).toBe(carol.identity.userId);
  });

  it('fails over when members report the host unreachable', async () => {
    const { alice, bob, carol, sessionId } = await setup();
    const { state } = await alice.conn.request('session.join', { sessionId, caps: caps({ nat: 'open' }) });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await carol.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.report', { sessionId, epoch: state.epoch, issue: 'host_unreachable' });
    const st = await waitFor(() => {
      const s = lastSession(carol, sessionId);
      return s && s.host !== alice.identity.userId ? s : null;
    }, 3000, 'report failover');
    expect(st.host).toBe(bob.identity.userId);
    expect(st.members).toHaveLength(3);
  });

  it('routes signalling only between session members and rejects outsiders', async () => {
    const { c, alice, bob, sessionId } = await setup();
    const outsider = await user(c);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    const data = { type: 'bye' as const, epoch: 1, dir: 'toRelay' as const };
    const r = await bob.conn.request('signal.send', { to: alice.identity.userId, sessionId, data });
    expect(r.delivered).toBe(true);
    await waitFor(() => alice.events.find((e) => e.ev === 'signal'));
    await expect(outsider.conn.request('session.join', { sessionId, caps: caps() })).rejects.toThrow(/not a member/);
    await expect(outsider.conn.request('signal.send', { to: alice.identity.userId, sessionId, data })).rejects.toThrow(/join the session/);
  });

  it('publishes voice channel occupancy to watchers', async () => {
    const { alice, bob, spaceId, voiceChannel, sessionId } = await setup();
    const snap = await bob.conn.request('voice.watch', { spaceIds: [spaceId] });
    expect(snap.voice).toEqual([]);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    const ev = await waitFor(() => bob.events.find((e) => e.ev === 'voice'));
    expect(ev.d).toMatchObject({ spaceId, channelId: voiceChannel, members: [alice.identity.userId] });
  });
});

describe('coordination mesh', () => {
  async function mesh() {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().length === 1 && b.mesh.peerIds().length === 1, 5000, 'mesh link');
    return { a, b };
  }

  it('replicates records and presence across servers', async () => {
    const { a, b } = await mesh();
    const alice = await user(a, 'alice');
    const bob = await user(b, 'bob');
    await waitFor(() => b.records.get(recordKey.profile(alice.identity.userId)), 3000, 'replication');
    const found = await bob.conn.request('users.search', { query: 'alice' });
    expect(found.profiles).toHaveLength(1);
    const { presence } = await bob.conn.request('presence.subscribe', { userIds: [alice.identity.userId] });
    expect(presence[0]?.status).toBe('online');
    alice.conn.close();
    await waitFor(() => bob.events.find((e) => e.ev === 'presence' && (e.d as { status: string }).status === 'offline'), 3000, 'offline');
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
    expect(r2.state.host).toBe(alice.identity.userId);
    expect(r2.state.id).toBe(r1.state.id);

    const sig = await bob.conn.request('signal.send', {
      to: alice.identity.userId,
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
      const st = await waitFor(() => {
        const x = survivor.sessions.ownedState(sessionId);
        return x && x.members.length === 1 ? x : null;
      }, 5000, 'rebuild');
      expect(st.host).toBe(alice.identity.userId);
      expect(st.epoch).toBe(r2.state.epoch);
    } else {
      // Alice's server owns it and Alice is host: killing A drops Alice, Bob takes over.
      await a.stop();
      const st = await waitFor(() => {
        const x = survivor.sessions.ownedState(sessionId);
        return x && x.host === bob.identity.userId ? x : null;
      }, 5000, 'takeover');
      expect(st.members.map((m) => m.userId)).toEqual([survivingUser.identity.userId]);
    }
  });
});
