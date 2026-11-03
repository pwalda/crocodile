import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentity, signMailProof, signRecord } from '@crocodile/crypto';
import { recordKey, sessionIds } from '@crocodile/protocol';
import type { Coordinator } from '@crocodile/coordinator';
import { KeyedLimiter, addressKey } from '../packages/coordinator/src/util';
import { FRAMES_BURST } from '../packages/coordinator/src/mesh';
import { caps, connectUser, meshLinkTo, startCoordinator, waitFor, type TestUser } from './helpers';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

/** What a request is answered with, failure or not. */
const answer = (u: TestUser, method: string, params: unknown = {}) =>
  (u.conn.request as (m: string, p: unknown) => Promise<unknown>)(method, params).then(
    () => 'ok',
    (e: Error & { code?: string }) => `${e.code}: ${e.message}`,
  );

describe('names of requests', () => {
  it('are looked up among the requests there are, not among what every object has', async () => {
    const c = await server();
    const error = vi.spyOn(c.log, 'error');
    const alice = await user(c);
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(await answer(alice, name), name).toBe(`not_found: unknown method ${name}`);
    // (Not a failure of ours: nothing is logged as one.)
    expect(error).not.toHaveBeenCalled();
    expect(await answer(alice, 'servers.list')).toBe('ok');
  });
});

describe('guesses at a device link code', () => {
  const guess = (u: TestUser) => answer(u, 'link.claim', { code: 'WRONGCODE' });

  it('are counted for the address they come from, not only for the connection', async () => {
    const c = await server();
    // Six connections spend what a connection may (five each): the address has 30.
    for (let i = 0; i < 6; i++) {
      const u = await user(c);
      for (let j = 0; j < 5; j++) expect(await guess(u), `${i}.${j}`).not.toMatch(/too many/);
    }
    // A new connection has a budget of its own, and the address has none left.
    const fresh = await user(c);
    expect(await guess(fresh)).toMatch(/too many attempts/);
  });

  it('still go through while the address has some left', async () => {
    const c = await server();
    const u = await user(c);
    expect(await guess(u)).toMatch(/not_found/);
  });
});

describe('what an address is counted as', () => {
  it('is the address, or for IPv6 the /64 it belongs to', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    const net = '2001:db8:1:2';
    for (const ip of [
      `${net}::1`,
      `${net}:ffff:ffff:ffff:ffff`,
      `${net}:0:0:0:1`,
      `${net.toUpperCase()}::abcd`,
      `${net}::1%eth0`,
    ])
      expect(addressKey(ip), ip).toBe(net);
    expect(addressKey('2001:db8:1:3::1')).not.toBe(net);
    expect(addressKey('::1')).toBe('0:0:0:0');
    expect(addressKey('2001:db8::')).toBe('2001:db8:0:0');
    expect(addressKey(undefined)).toBe('');
  });
});

describe('a limiter kept for each key', () => {
  it('forgets keys that have filled up again, and refuses new ones while it is full of busy ones', () => {
    vi.useFakeTimers();
    const limiter = new KeyedLimiter(1, 2, 3);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('c')).toBe(true);
    // Three keys have spent something: a fourth waits.
    expect(limiter.take('d')).toBe(false);
    expect(limiter.size).toBe(3);
    // After two seconds a, b and c are full again, which is as good as new.
    vi.advanceTimersByTime(2000);
    expect(limiter.take('d')).toBe(true);
    expect(limiter.size).toBe(1);
    // (A key that came back is not given more than its burst.)
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });
});

describe('mail requests that are passed on to the mesh', () => {
  async function setup() {
    const c = await server();
    const alice = await user(c);
    const flood = vi.spyOn(c.mesh, 'flood');
    const proof = (server: string) =>
      signMailProof(alice.identity, { t: 'mail_fetch', peer: alice.conn.peer, server });
    return { c, alice, flood, proof };
  }

  it('are signed for this server, or they go no further', async () => {
    const { c, alice, flood, proof } = await setup();
    expect(await answer(alice, 'mail.fetch', { proof: proof(c.info.id) })).toBe('ok');
    expect(flood).toHaveBeenCalledTimes(1);
    expect(flood.mock.calls[0]![0]).toMatchObject({ t: 'mail_query', peer: alice.conn.peer });
    flood.mockClear();
    // Signed for another server, by someone else, or long ago; or not signed.
    const other = createIdentity();
    const forged = signMailProof(other, {
      t: 'mail_fetch',
      peer: alice.conn.peer,
      server: c.info.id,
    });
    const old = signMailProof(
      alice.identity,
      { t: 'mail_fetch', peer: alice.conn.peer, server: c.info.id },
      Date.now() - 10 * 60_000,
    );
    for (const bad of [proof('someoneelse'), forged, old, undefined])
      expect(await answer(alice, 'mail.fetch', bad ? { proof: bad } : {})).toBe('ok');
    expect(flood).not.toHaveBeenCalled();
  });

  it('are acknowledged here whatever the signature, and passed on only with a good one', async () => {
    const { alice, flood } = await setup();
    const ids = ['m1'];
    const good = signMailProof(alice.identity, { t: 'mail_ack', peer: alice.conn.peer, ids });
    expect(await answer(alice, 'mail.ack', { ids, proof: good })).toBe('ok');
    expect(flood).toHaveBeenCalledTimes(1);
    expect(flood.mock.calls[0]![0]).toMatchObject({ t: 'mail_ack', ids });
    flood.mockClear();
    // Signed for other ids, or by someone else.
    const other = signMailProof(alice.identity, {
      t: 'mail_ack',
      peer: alice.conn.peer,
      ids: ['x'],
    });
    const forged = signMailProof(createIdentity(), { t: 'mail_ack', peer: alice.conn.peer, ids });
    for (const bad of [other, forged, undefined])
      expect(await answer(alice, 'mail.ack', bad ? { ids, proof: bad } : { ids })).toBe('ok');
    expect(flood).not.toHaveBeenCalled();
  });

  it('are held to a budget of their own, apart from sending mail', async () => {
    const { alice } = await setup();
    const results: string[] = [];
    for (let i = 0; i < 60; i++) results.push(await answer(alice, 'mail.fetch'));
    expect(results.filter((r) => /too fast/.test(r)).length).toBeGreaterThan(0);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThanOrEqual(50);
    // Sending is not held up by it.
    expect(await answer(alice, 'mail.put', { items: [] })).not.toMatch(/too fast/);
  });
});

describe('a signal between devices', () => {
  const bye = { type: 'bye' as const, epoch: 1, dir: 'toRelay' as const };

  async function pair(c: Coordinator) {
    const alice = await user(c);
    const bob = await user(c);
    const sessionId = sessionIds.dm(alice.identity.userId, bob.identity.userId);
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    return { alice, bob, sessionId };
  }
  const signals = (u: TestUser) => u.events.filter((e) => e.ev === 'signal');

  it('reaches a device in the session, and is answered the same whoever is online', async () => {
    const c = await server();
    const { alice, bob, sessionId } = await pair(c);
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    const data = { to: alice.conn.peer, sessionId, data: bye };
    expect(await answer(bob, 'signal.send', data)).toBe('ok');
    await waitFor(() => signals(alice).length === 1, 3000, 'signal');
    // The answer says nothing of whether it arrived.
    expect(await bob.conn.request('signal.send', data)).toEqual({});
  });

  it('does not reach a device that is connected but not in the session, or say whether it is', async () => {
    const c = await server();
    const { alice, bob, sessionId } = await pair(c);
    // Bob is online and in no session; Carol's device does not exist.
    const nobody = `${createIdentity().userId}.abcdefgh`;
    const sent = [bob.conn.peer, nobody].map((to) =>
      alice.conn.request('signal.send', { to, sessionId, data: bye }),
    );
    // The same answer for a device that is online and for one that is not.
    expect(await Promise.all(sent)).toEqual([{}, {}]);
    await new Promise((r) => setTimeout(r, 200));
    expect(signals(bob)).toHaveLength(0);
  });

  it('is not passed on by a server to a device that is not in the session', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().includes(b.info.id), 5000, 'mesh');
    const alice = await user(a);
    const bob = await user(b);
    const sessionId = sessionIds.dm(alice.identity.userId, bob.identity.userId);
    await waitFor(() => a.presence.locatePeer(bob.conn.peer), 3000, 'presence');
    await alice.conn.request('session.join', { sessionId, caps: caps() });
    await alice.conn.request('signal.send', { to: bob.conn.peer, sessionId, data: bye });
    await new Promise((r) => setTimeout(r, 300));
    expect(signals(bob)).toHaveLength(0);
    // Once Bob is in, it gets there.
    await bob.conn.request('session.join', { sessionId, caps: caps() });
    await alice.conn.request('signal.send', { to: bob.conn.peer, sessionId, data: bye });
    await waitFor(() => signals(bob).length === 1, 3000, 'signal across servers');
  });
});

describe('invitations to a conversation', () => {
  const invitesOf = (u: TestUser) => u.events.filter((e) => e.ev === ('session_invite' as never));

  async function pair() {
    const c = await server();
    const alice = await user(c);
    const bob = await user(c);
    const invites: unknown[] = [];
    bob.conn.on('session_invite', (d) => invites.push(d));
    const sessionId = sessionIds.dm(alice.identity.userId, bob.identity.userId);
    return { c, alice, bob, sessionId, invites };
  }
  const joinAndLeave = async (u: TestUser, sessionId: string) => {
    await u.conn.request('session.join', { sessionId, caps: caps() });
    await u.conn.request('session.leave', { sessionId });
  };

  it('are not sent again at once for each time the other one joins', async () => {
    const { alice, sessionId, invites } = await pair();
    for (let i = 0; i < 5; i++) await joinAndLeave(alice, sessionId);
    await waitFor(() => invites.length >= 1, 3000, 'an invitation');
    await new Promise((r) => setTimeout(r, 200));
    expect(invites).toHaveLength(1);
    expect(invitesOf(alice)).toHaveLength(0);
  });

  it('come again after the wait, and at once if the first one went nowhere', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const c = await server();
    const alice = await user(c);
    const other = createIdentity();
    const sessionId = sessionIds.dm(alice.identity.userId, other.userId);
    // Bob is not connected: nothing reached him, so nothing is held back.
    const deliver = vi.spyOn(c, 'deliver');
    await joinAndLeave(alice, sessionId);
    await joinAndLeave(alice, sessionId);
    expect(deliver.mock.calls.filter(([, ev]) => ev === 'session_invite')).toHaveLength(2);
    // Bob comes, is invited once, and again only after the wait.
    const bob = await connectUser(c, other, 'bob');
    cleanup.push(() => bob.conn.close());
    const invites: unknown[] = [];
    bob.conn.on('session_invite', (d) => invites.push(d));
    await joinAndLeave(alice, sessionId);
    await joinAndLeave(alice, sessionId);
    await waitFor(() => invites.length === 1, 3000, 'first invitation');
    vi.setSystemTime(Date.now() + 20_000);
    await joinAndLeave(alice, sessionId);
    await waitFor(() => invites.length === 2, 3000, 'second invitation');
  });
});

describe('conversations a device is in at once', () => {
  it('are held to a number, which does not apply to a conversation it is already in, or to spaces', async () => {
    const c = await server();
    (c.sessions as unknown as { dmSessionsMax: number }).dmSessionsMax = 3;
    const alice = await user(c);
    const dm = () => sessionIds.dm(alice.identity.userId, createIdentity().userId);
    const open = [dm(), dm(), dm()];
    for (const sessionId of open)
      await alice.conn.request('session.join', { sessionId, caps: caps() });
    expect(await answer(alice, 'session.join', { sessionId: dm(), caps: caps() })).toMatch(
      /rate_limited: too many conversations/,
    );
    // Joining one it is in already (as it does when a connection is renewed) is not a new one.
    expect(await answer(alice, 'session.join', { sessionId: open[0], caps: caps() })).toBe('ok');
    // Leaving one makes room.
    await alice.conn.request('session.leave', { sessionId: open[1]! });
    expect(await answer(alice, 'session.join', { sessionId: dm(), caps: caps() })).toBe('ok');
    expect(c.sessions.sessionsOf(alice.conn.peer).filter((s) => s.startsWith('dm:'))).toHaveLength(
      3,
    );
    // Another device has its own count.
    const bob = await user(c);
    expect(
      await answer(bob, 'session.join', {
        sessionId: sessionIds.dm(bob.identity.userId, createIdentity().userId),
        caps: caps(),
      }),
    ).toBe('ok');
  });
});

describe('what a server in the mesh may send', () => {
  async function link() {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(
      () => a.mesh.peerIds().includes(b.info.id) && b.mesh.peerIds().includes(a.info.id),
      5000,
      'mesh',
    );
    return { a, b, toA: meshLinkTo(b, a.info.id) };
  }

  it('is as many frames as a busy peer needs, and no more: a link past it is closed', async () => {
    const { a, toA } = await link();
    const warn = vi.spyOn(a.log, 'warn');
    // The clock stands still, so that nothing is added to the budget while the frames are read.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    for (let i = 0; i < FRAMES_BURST + 100; i++) toA.send({ t: 'pong' });
    for (let i = 0; i < 400 && toA.open; i++) await new Promise((r) => setTimeout(r, 20));
    expect(toA.open).toBe(false);
    expect(warn).toHaveBeenCalledWith('closing a mesh link that sends too fast', expect.anything());
  });

  it('leaves a link that sends a good deal, but not that much, as it is', async () => {
    const { toA } = await link();
    for (let i = 0; i < 2000; i++) toA.send({ t: 'pong' });
    await new Promise((r) => setTimeout(r, 300));
    expect(toA.open).toBe(true);
  });

  it('is told of a flood once, and only so many are remembered, oldest first', async () => {
    const { a, toA } = await link();
    const seen = (a.mesh as unknown as { floodSeen: Map<string, number> }).floodSeen;
    const now = Date.now();
    for (let i = 0; i < 200_500; i++) seen.set(`old${i}`, now);
    const peer = `${createIdentity().userId}.abcdefgh`;
    toA.send({
      t: 'flood',
      id: 'newest',
      origin: createIdentity().userId,
      hops: 0,
      f: { t: 'mail_query', peer },
    });
    await waitFor(() => seen.has('newest'), 3000, 'flood seen');
    expect(seen.size).toBeLessThanOrEqual(200_000);
    expect(seen.has('old0')).toBe(false);
    expect(seen.has('old200499')).toBe(true);
  });

  it('lets a server catch up on more records than one batch holds', async () => {
    const a = await server({ name: 'A' });
    const keys: string[] = [];
    for (let i = 0; i < 1100; i++) {
      const who = createIdentity();
      const key = recordKey.profile(who.userId);
      const record = signRecord(who, 'profile', key, {
        username: `u${i}`,
        encKey: who.encPublicKey,
      });
      const res = a.records.put(record, { fresh: false, origin: null });
      expect(res.accepted, res.reason).toBe(true);
      keys.push(key);
    }
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => keys.every((k) => b.records.get(k)), 20_000, 'all records replicated');
  }, 40_000);
});
