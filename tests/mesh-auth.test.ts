import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createChannelKeys,
  createIdentity,
  keyMatchesUserId,
  sign,
  signSessionOp,
  verifyPayload,
  type Identity,
} from '@crocodile/crypto';
import {
  PROTOCOL_VERSION,
  SIG_DOMAIN,
  peerIds,
  presenceSigned,
  sessionIds,
  voiceSigned,
  type FedPresence,
  type HostCaps,
} from '@crocodile/protocol';
import { Coordinator, rendezvousOwner } from '@crocodile/coordinator';
import { RpcFailure } from '../packages/coordinator/src/util';
import {
  caps,
  connectUser,
  meshLinkTo,
  registerDevice,
  startCoordinator,
  waitFor,
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

/** `victim` is linked to an honest server and to a rogue one. */
async function threeServers() {
  const victim = await server({ name: 'victim' });
  const honest = await server({ name: 'honest', meshPeers: [victim.url] });
  const rogue = await server({ name: 'rogue', meshPeers: [victim.url] });
  await waitFor(
    () =>
      victim.mesh.peerIds().length === 2 &&
      rogue.mesh.peerIds().includes(victim.info.id) &&
      honest.mesh.peerIds().includes(victim.info.id),
    5000,
    'mesh links',
  );
  return { victim, honest, rogue };
}

const cursorOf = (c: Coordinator, serverId: string) =>
  Number(c.records.store.getMeta(`cursor:${serverId}`) ?? 0);

describe('a mesh link keeps the identity it authenticated with', () => {
  it('closes a link that sends a second hello and credits nothing to the identity in it', async () => {
    const { victim, honest, rogue } = await threeServers();
    const toVictim = meshLinkTo(rogue, victim.info.id);
    const offer = { x25519: 'a'.repeat(43), mlkem: 'b'.repeat(100) };

    toVictim.send({
      t: 'fed_hello',
      server: honest.info,
      challenge: 'c',
      channel: offer,
      protocol: 99,
    });
    // Would move the honest server's catch-up cursor if it were credited to it.
    toVictim.send({ t: 'records', items: [], upTo: 5_000_000 });

    await waitFor(
      () => !victim.mesh.peerIds().includes(rogue.info.id),
      3000,
      'the rogue link to be dropped',
    );
    expect(cursorOf(victim, honest.info.id)).toBe(0);
    // The honest server's own link is untouched.
    expect(victim.mesh.peerIds()).toContain(honest.info.id);
  });

  it('closes a link that introduces itself twice before it has authenticated', async () => {
    const victim = await server({ name: 'victim' });
    const honest = await server({ name: 'honest' });
    const ws = new WebSocket(victim.url.replace(/^http/, 'ws') + '/v1/federation');
    const received: string[] = [];
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data)).t));
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.code)),
    );
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const hello = () =>
      JSON.stringify({
        t: 'fed_hello',
        server: honest.info,
        challenge: 'c',
        channel: createChannelKeys().offer,
        protocol: PROTOCOL_VERSION,
      });
    ws.send(hello());
    await waitFor(() => received.includes('fed_auth'), 3000, 'the answer to the first hello');
    ws.send(hello());
    expect(await closed).toBe(1008);
    expect(received.filter((t) => t === 'fed_auth')).toHaveLength(1);
  });
});

type Entry = FedPresence['entries'][number];
const entry = (userId: string, devices = ['d1']): Entry => ({
  userId,
  status: 'online',
  since: Date.now(),
  devices,
});

/** A presence frame as `from` itself would sign it. */
function presenceFrom(from: Coordinator, seq: number, entries: Entry[], full = false) {
  const parts = { origin: from.info.id, seq, full, entries };
  return {
    t: 'presence',
    ...parts,
    key: from.info.key,
    sig: sign(from.identity, SIG_DOMAIN.presence, presenceSigned(parts)),
  };
}

const base32 = (n: number) =>
  Array.from(randomBytes(n), (b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32]).join('');
const online = (c: Coordinator, userId: string) =>
  c.presence.publicEntry(userId).status === 'online';

describe('presence from other servers', () => {
  /** Alice is on the honest server; the victim has heard so. */
  async function withAlice() {
    const net = await threeServers();
    const alice = await connectUser(net.honest, createIdentity(), 'alice');
    cleanup.push(() => alice.conn.close());
    await waitFor(() => online(net.victim, alice.identity.userId), 3000, 'alice to be online');
    return {
      ...net,
      alice: alice.identity.userId,
      toVictim: meshLinkTo(net.rogue, net.victim.info.id),
    };
  }

  /** Frames on one link are handled in order: once this one has landed, so have the ones before it. */
  async function barrier(net: Awaited<ReturnType<typeof withAlice>>) {
    const marker = createIdentity().userId;
    net.toVictim.send(presenceFrom(net.rogue, Date.now(), [entry(marker)]));
    await waitFor(() => online(net.victim, marker), 3000, 'the marker to land');
  }

  it('does not let a server take over the users of another with a made-up frame', async () => {
    const net = await withAlice();
    for (const seq of [1e15, Date.now() + 60_000]) {
      net.toVictim.send({
        t: 'presence',
        origin: net.honest.info.id,
        seq,
        full: true,
        entries: [],
        key: net.honest.info.key,
        sig: 'x'.repeat(86),
      });
    }
    await barrier(net);
    expect(online(net.victim, net.alice)).toBe(true);
  });

  it('does not let a server claim a user under the name of another', async () => {
    const net = await withAlice();
    const target = createIdentity().userId;
    const parts = {
      origin: net.honest.info.id,
      seq: Date.now(),
      full: false,
      entries: [entry(target)],
    };
    // Signed by nobody, and signed by the rogue server but under the honest one's id.
    net.toVictim.send({ t: 'presence', ...parts, key: net.honest.info.key, sig: 'x'.repeat(86) });
    net.toVictim.send({
      t: 'presence',
      ...parts,
      key: net.rogue.info.key,
      sig: sign(net.rogue.identity, SIG_DOMAIN.presence, presenceSigned(parts)),
    });
    await barrier(net);
    expect(net.victim.presence.remoteServersOf(target)).toEqual([]);
  });

  it('takes a server at its word about its own users, but not a sequence number from the far future', async () => {
    const net = await withAlice();
    const fine = createIdentity().userId;
    const poisoned = createIdentity().userId;
    net.toVictim.send(presenceFrom(net.rogue, 1e15, [entry(poisoned)]));
    net.toVictim.send(presenceFrom(net.rogue, Date.now(), [entry(fine)]));
    await waitFor(() => online(net.victim, fine), 3000, 'its own user to land');
    expect(online(net.victim, poisoned)).toBe(false);
  });

  it('does not bring back a user who has gone when it catches a new neighbour up', async () => {
    const honest = await server({ name: 'honest' });
    const alice = await connectUser(honest, createIdentity(), 'alice');
    const bob = await connectUser(honest, createIdentity(), 'bob');
    cleanup.push(() => alice.conn.close());
    const [a, b] = [alice.identity.userId, bob.identity.userId];
    const victim = await server({ name: 'victim', meshPeers: [honest.url] });
    await waitFor(() => online(victim, a) && online(victim, b), 3000, 'both to be online');
    bob.conn.close();
    await waitFor(() => !online(victim, b), 3000, 'bob to go');

    // What the victim would tell a server that has just linked to it.
    const late = await server({ name: 'late' });
    for (const f of victim.presence.snapshot()) {
      expect(keyMatchesUserId(f.key, f.origin)).toBe(true);
      expect(verifyPayload(f.key, SIG_DOMAIN.presence, presenceSigned(f), f.sig)).toBe(true);
      late.presence.applyRemote(f);
    }
    expect(online(late, b)).toBe(false);

    // And a server that links to it for real ends up with the current picture.
    const linked = await server({ name: 'linked', meshPeers: [victim.url] });
    await waitFor(() => online(linked, a), 5000, 'alice to be seen');
    expect(online(linked, b)).toBe(false);
  });
});

describe('voice occupancy from other servers', () => {
  /** A voice session the victim sees `rogue` as the owner of, or not. */
  function sessionOwnedBy(net: Awaited<ReturnType<typeof threeServers>>, byRogue: boolean) {
    for (;;) {
      const spaceId = base32(16);
      const channelId = base32(16);
      const sessionId = `voice:${spaceId}:${channelId}`;
      const owner = rendezvousOwner(sessionId, net.victim.membership.liveIds());
      if ((owner === net.rogue.info.id) === byRogue)
        return { spaceId, channelId, sessionId, owner };
    }
  }

  function voiceFrom(
    from: Coordinator,
    s: { spaceId: string; channelId: string; sessionId: string },
    at: number,
  ) {
    const user = createIdentity().userId;
    const parts = {
      sessionId: s.sessionId,
      occ: { spaceId: s.spaceId, channelId: s.channelId, members: [user], host: user },
      owner: from.info.id,
      at,
    };
    return {
      t: 'voice',
      ...parts,
      key: from.info.key,
      sig: sign(from.identity, SIG_DOMAIN.voice, voiceSigned(parts)),
    };
  }

  it('shows an occupied room only when its owner said so, recently, in a frame it signed', async () => {
    const net = await threeServers();
    const toVictim = meshLinkTo(net.rogue, net.victim.info.id);
    const mine = sessionOwnedBy(net, true);
    const notMine = sessionOwnedBy(net, false);
    const stale = sessionOwnedBy(net, true);
    const forged = sessionOwnedBy(net, false);
    const shown = (s: { spaceId: string }) => net.victim.sessions.voiceSnapshot([s.spaceId]).length;

    // Made up in the name of the real owner, with nothing signed.
    const f = voiceFrom(net.rogue, forged, Date.now());
    toVictim.send({ ...f, owner: forged.owner, key: net.honest.info.key, sig: 'x'.repeat(86) });
    // Signed by the rogue server for a room that is not its to announce.
    toVictim.send(voiceFrom(net.rogue, notMine, Date.now()));
    // Signed, its room, but announced twenty minutes ago.
    toVictim.send(voiceFrom(net.rogue, stale, Date.now() - 20 * 60_000));
    toVictim.send(voiceFrom(net.rogue, mine, Date.now()));
    await waitFor(() => shown(mine), 3000, 'its own room to land');
    expect(shown(forged)).toBe(0);
    expect(shown(notMine)).toBe(0);
    expect(shown(stale)).toBe(0);
  });
});

describe('events and session operations from other servers', () => {
  /**
   * Alice is on `victim`, Bob on `honest`, and their conversation is owned by
   * `victim`. `rogue` is a third server writing into its link to the victim.
   */
  async function conversation() {
    const net = await threeServers();
    let a = createIdentity();
    let b = createIdentity();
    while (
      rendezvousOwner(sessionIds.dm(a.userId, b.userId), net.victim.membership.liveIds()) !==
      net.victim.info.id
    ) {
      a = createIdentity();
      b = createIdentity();
    }
    const alice = await connectUser(net.victim, a, 'alice');
    const bob = await connectUser(net.honest, b, 'bob');
    cleanup.push(() => alice.conn.close());
    cleanup.push(() => bob.conn.close());
    const invites: unknown[] = [];
    alice.conn.on('session_invite', (d) => invites.push(d));
    await waitFor(
      () => online(net.victim, b.userId) && online(net.honest, a.userId),
      3000,
      'users',
    );
    return {
      ...net,
      alice,
      bob,
      invites,
      sessionId: sessionIds.dm(a.userId, b.userId),
      toVictim: meshLinkTo(net.rogue, net.victim.info.id),
    };
  }
  type Net = Awaited<ReturnType<typeof conversation>>;

  const bye = { type: 'bye' as const, epoch: 1, dir: 'toRelay' as const };

  async function joined(net: Net) {
    await net.alice.conn.request('session.join', { sessionId: net.sessionId, caps: caps() });
    await net.bob.conn.request('session.join', { sessionId: net.sessionId, caps: caps() });
    return () => net.victim.sessions.ownedState(net.sessionId)!;
  }

  /** The marker lands after everything sent before it on the link. */
  async function settled(net: Net) {
    const marker = createIdentity().userId;
    net.toVictim.send(presenceFrom(net.rogue, Date.now(), [entry(marker)]));
    await waitFor(() => online(net.victim, marker), 3000, 'the marker to land');
  }

  /**
   * What the rogue server sends the owner for a device. With `holder`, the holder of the
   * account's key has signed it for the rogue server (the device is on it, as far as the others
   * can tell): the one thing it cannot do for an account it holds no key of.
   */
  const op = (
    net: Net,
    peer: string,
    body: { op: string; caps?: unknown; epoch?: number; issue?: string; hint?: unknown },
    holder?: Identity,
    ctx: { at?: number; since?: number; n?: number } = {},
  ) => {
    const signed =
      holder && body.op !== 'leave'
        ? signSessionOp(
            holder,
            net.sessionId,
            peer,
            body.op === 'report'
              ? { op: 'report', epoch: body.epoch!, issue: 'host_unreachable' }
              : { op: body.op as 'join' | 'update', caps: body.caps as HostCaps },
            { server: net.rogue.info.id, ...ctx },
          )
        : undefined;
    net.toVictim.send({
      t: 'session_op',
      opId: 'o1',
      sessionId: net.sessionId,
      peer,
      op: body,
      ...(signed ? { proof: signed } : {}),
    });
  };

  describe('routed events', () => {
    it('delivers a signal only from the server that has the sender connected', async () => {
      const net = await conversation();
      const state = await joined(net);
      expect(state().members).toHaveLength(2);
      const signals = () => net.alice.events.filter((e) => e.ev === 'signal');
      // Made up by the rogue server, in Bob's name.
      net.toVictim.send({
        t: 'route',
        to: net.alice.conn.peer,
        ev: 'signal',
        d: { from: net.bob.conn.peer, sessionId: net.sessionId, data: bye },
      });
      await settled(net);
      expect(signals()).toHaveLength(0);
      // Bob's own server may.
      await net.bob.conn.request('signal.send', {
        to: net.alice.conn.peer,
        sessionId: net.sessionId,
        data: bye,
      });
      await waitFor(() => signals().length === 1, 3000, 'the real signal');
    });

    it('delivers an invitation only from the server that owns the conversation', async () => {
      const net = await conversation();
      net.toVictim.send({
        t: 'route',
        to: net.alice.identity.userId,
        ev: 'session_invite',
        d: { sessionId: net.sessionId, from: net.bob.identity.userId },
      });
      await settled(net);
      expect(net.invites).toHaveLength(0);
    });

    it('drops events whose content is not what the event says', async () => {
      const net = await conversation();
      net.toVictim.send({ t: 'route', to: net.alice.conn.peer, ev: 'mail', d: { items: 'x' } });
      net.toVictim.send({ t: 'route', to: net.alice.conn.peer, ev: 'signal', d: { from: 5 } });
      net.toVictim.send({
        t: 'route',
        to: net.alice.identity.userId,
        ev: 'relay_expired',
        d: { reason: 'the rogue server says so' },
      });
      await settled(net);
      expect(
        net.alice.events.filter((e) => ['mail', 'signal', 'relay_expired'].includes(e.ev)),
      ).toEqual([]);
    });
  });

  describe('session operations', () => {
    it('refuses operations for a device the sender does not have connected', async () => {
      const net = await conversation();
      const state = await joined(net);
      // Kick Bob, and fail the host over, in the name of the rogue server.
      op(net, net.bob.conn.peer, { op: 'leave' });
      op(net, net.alice.conn.peer, {
        op: 'report',
        epoch: state().epoch,
        issue: 'host_unreachable',
      });
      await settled(net);
      expect(
        state()
          .members.map((m) => m.peer)
          .sort(),
      ).toEqual([net.alice.conn.peer, net.bob.conn.peer].sort());
      expect(state().epoch).toBeLessThan(5);
    });

    it('still lets a member on another server leave when it disconnects', async () => {
      const net = await conversation();
      const state = await joined(net);
      expect(state().members).toHaveLength(2);
      // Bob's server says he has gone, and then that he has left the conversation.
      net.bob.conn.close();
      await waitFor(
        () => state().members.length === 1,
        4000,
        'bob to be taken out of the conversation',
      );
      expect(state().members[0]!.peer).toBe(net.alice.conn.peer);
    });

    it('checks again that whoever joins may', async () => {
      const net = await conversation();
      const state = await joined(net);
      // The rogue server says Mallory is on it, which it may; she is not in the conversation.
      const outsider = createIdentity();
      const mallory = outsider.userId;
      const peer = peerIds.make(mallory, 'abcdefgh');
      net.toVictim.send(presenceFrom(net.rogue, Date.now(), [entry(mallory, ['abcdefgh'])]));
      op(
        net,
        peer,
        { op: 'join', caps: caps(), hint: { epoch: 1e9, host: peer, backup: null } },
        outsider,
      );
      await settled(net);
      expect(state().members.map((m) => m.userId)).not.toContain(mallory);
      expect(state().epoch).toBeLessThan(5);
    });

    it('does not let a server join a device that has no record', async () => {
      const net = await conversation();
      const state = await joined(net);
      // The rogue server says Alice has another device on it; she has never made one.
      const peer = peerIds.make(net.alice.identity.userId, 'abcdefgh');
      net.toVictim.send(
        presenceFrom(net.rogue, Date.now(), [entry(net.alice.identity.userId, ['abcdefgh'])]),
      );
      op(net, peer, { op: 'join', caps: caps({ nat: 'open' }) }, net.alice.identity);
      await settled(net);
      // The record is looked for for a moment before the join is given up on.
      await new Promise((r) => setTimeout(r, 1500));
      expect(state().members.map((m) => m.peer)).not.toContain(peer);
    });

    it('does not take a host or backup that is a device with no record', async () => {
      const net = await conversation();
      const state = await joined(net);
      // Alice's real device, claimed by the rogue server, names a device she never made as host.
      const device = peerIds.device(net.alice.conn.peer);
      net.toVictim.send(
        presenceFrom(net.rogue, Date.now(), [entry(net.alice.identity.userId, [device])]),
      );
      const ghost = peerIds.make(net.alice.identity.userId, 'abcdefgh');
      op(
        net,
        net.alice.conn.peer,
        {
          op: 'join',
          caps: caps(),
          hint: { epoch: 1000, host: ghost, backup: null },
        },
        net.alice.identity,
      );
      await settled(net);
      expect(state().host).not.toBe(ghost);
      expect(state().epoch).toBeLessThan(5);
    });

    it('answers a join to a room that is not there with what the check said, not forbidden', async () => {
      const net = await conversation();
      await joined(net);
      const sessions = net.victim.sessions as unknown as {
        checkAccess(...a: unknown[]): Promise<void>;
        admit(...a: unknown[]): Promise<{ code?: string }>;
      };
      const check = vi
        .spyOn(sessions, 'checkAccess')
        .mockRejectedValueOnce(new RpcFailure('not_found', 'no such voice channel'));
      const answer = await sessions.admit(net.rogue.info.id, net.alice.conn.peer, net.sessionId, {
        op: 'join',
        caps: caps(),
      });
      check.mockRestore();
      expect(answer.code).toBe('not_found');
    });

    it('does not call a failure to find out whether a device may join a refusal', async () => {
      const net = await conversation();
      await joined(net);
      const sessions = net.victim.sessions as unknown as {
        checkAccess(...a: unknown[]): Promise<void>;
        admit(...a: unknown[]): Promise<{ code?: string }>;
      };
      const check = vi
        .spyOn(sessions, 'checkAccess')
        .mockRejectedValueOnce(new Error('shard owners unreachable'));
      const answer = await sessions.admit(net.rogue.info.id, net.alice.conn.peer, net.sessionId, {
        op: 'join',
        caps: caps(),
      });
      check.mockRestore();
      expect(answer.code).toBe('unavailable');
    });

    it('keeps the epoch of a hint that names no host', async () => {
      const net = await conversation();
      const state = await joined(net);
      const device = peerIds.device(net.alice.conn.peer);
      net.toVictim.send(
        presenceFrom(net.rogue, Date.now(), [entry(net.alice.identity.userId, [device])]),
      );
      op(
        net,
        net.alice.conn.peer,
        {
          op: 'join',
          caps: caps(),
          hint: { epoch: 1000, host: null, backup: null },
        },
        net.alice.identity,
      );
      await waitFor(() => state().epoch >= 1000, 5000, 'the epoch to be kept');
    });

    it('keeps the host a hint names when only the backup it names is not a device that exists', async () => {
      const net = await conversation();
      const state = await joined(net);
      const device = peerIds.device(net.alice.conn.peer);
      net.toVictim.send(
        presenceFrom(net.rogue, Date.now(), [entry(net.alice.identity.userId, [device])]),
      );
      const ghost = peerIds.make(net.alice.identity.userId, 'abcdefgh');
      op(
        net,
        net.alice.conn.peer,
        {
          op: 'join',
          caps: caps(),
          hint: { epoch: 1000, host: net.bob.conn.peer, backup: ghost },
        },
        net.alice.identity,
      );
      await waitFor(() => state().epoch >= 1000, 5000, 'the hint');
      expect(state().host).toBe(net.bob.conn.peer);
      expect(state().backup).not.toBe(ghost);
    });

    it("takes a device's operations in the order they were sent, also while its join is looked into", async () => {
      const net = await conversation();
      const state = await joined(net);
      // Another device of Alice's, with a record, that the rogue server says is on it.
      const second = await connectUser(net.victim, net.alice.identity, 'alice');
      cleanup.push(() => second.conn.close());
      const device = peerIds.device(second.conn.peer);
      net.toVictim.send(
        presenceFrom(net.rogue, Date.now(), [entry(net.alice.identity.userId, [device])]),
      );
      const sessions = net.victim.sessions as unknown as {
        admit(...a: unknown[]): Promise<unknown>;
      };
      const real = sessions.admit.bind(sessions);
      const admit = vi.spyOn(sessions, 'admit').mockImplementation(async (...a) => {
        await new Promise((r) => setTimeout(r, 400));
        return real(...a);
      });
      op(net, second.conn.peer, { op: 'join', caps: caps() }, net.alice.identity);
      op(net, second.conn.peer, { op: 'leave' });
      await settled(net);
      await new Promise((r) => setTimeout(r, 1200));
      admit.mockRestore();
      expect(state().members.map((m) => m.peer)).not.toContain(second.conn.peer);
    });

    it('looks into an update only if it comes from the server the member joined from', async () => {
      const net = await conversation();
      await joined(net);
      const find = vi.spyOn(
        net.victim.sessions as unknown as { findDevice(): unknown },
        'findDevice',
      );
      // The rogue server updates a device of Bob's, and one that does not exist.
      op(net, net.bob.conn.peer, { op: 'update', caps: caps({ nat: 'open' }) });
      op(net, peerIds.make(net.alice.identity.userId, 'abcdefgh'), {
        op: 'update',
        caps: caps({ nat: 'open' }),
      });
      await settled(net);
      expect(find).not.toHaveBeenCalled();
      find.mockRestore();
    });

    it('takes out of a room a device on another server that has been removed', async () => {
      const net = await conversation();
      const state = await joined(net);
      expect(state().members).toHaveLength(2);
      await registerDevice(net.bob, 'bot', true, Date.now() + 1000);
      // The record has to reach the owner's server first.
      const until = Date.now() + 5000;
      while (state().members.length > 1 && Date.now() < until) {
        await net.victim.sessions.recheckDevices();
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(state().members[0]!.peer).toBe(net.alice.conn.peer);
    });

    it('does not take a host from a member who was never there', async () => {
      const net = await conversation();
      const state = await joined(net);
      // The rogue server joins as Alice, which it claims to have, naming Mallory the host.
      net.toVictim.send(
        presenceFrom(net.rogue, Date.now(), [entry(net.alice.identity.userId, ['abcdefgh'])]),
      );
      const mallory = peerIds.make(createIdentity().userId, 'abcdefgh');
      op(
        net,
        peerIds.make(net.alice.identity.userId, 'abcdefgh'),
        {
          op: 'join',
          caps: caps(),
          hint: { epoch: 1e9, host: mallory, backup: null },
        },
        net.alice.identity,
      );
      await settled(net);
      expect(state().host).not.toBe(mallory);
      expect(state().epoch).toBeLessThan(5);
    });

    describe('what a device signs', () => {
      type Owned = Map<
        string,
        {
          memberServer: Map<string, string>;
          signed: Map<string, { since: number; n: number }>;
          reports: Map<string, string>;
        }
      >;
      const owned = (net: Net) =>
        (net.victim.sessions as unknown as { owned: Owned }).owned.get(net.sessionId)!;
      /** The rogue server claims Bob's device is on it, as a server that wants to speak for it must. */
      const claimBob = (net: Net) =>
        net.toVictim.send(
          presenceFrom(net.rogue, Date.now(), [
            entry(net.bob.identity.userId, [peerIds.device(net.bob.conn.peer)]),
          ]),
        );
      const memberOf = (net: Net, peer: string) =>
        net.victim.sessions.ownedState(net.sessionId)!.members.find((m) => m.peer === peer);
      const serverOf = (net: Net) => owned(net).memberServer.get(net.bob.conn.peer);
      const pause = () => new Promise((r) => setTimeout(r, 300));

      it('does not let a server take over the membership of a device that is on another', async () => {
        const net = await conversation();
        await joined(net);
        claimBob(net);
        expect(serverOf(net)).toBe(net.honest.info.id);
        // Nothing signed, and a signature by somebody else, as the key of Bob is not theirs.
        op(net, net.bob.conn.peer, { op: 'join', caps: caps({ nat: 'open' }) });
        op(net, net.bob.conn.peer, { op: 'join', caps: caps({ nat: 'open' }) }, createIdentity());
        await settled(net);
        await pause();
        expect(serverOf(net)).toBe(net.honest.info.id);
        expect(memberOf(net, net.bob.conn.peer)!.caps.nat).not.toBe('open');
        // Nor can it make Bob leave, or change what he says of himself.
        op(net, net.bob.conn.peer, { op: 'update', caps: caps({ nat: 'symmetric' }) });
        op(net, net.bob.conn.peer, { op: 'leave' });
        await settled(net);
        await pause();
        expect(memberOf(net, net.bob.conn.peer)!.caps.nat).not.toBe('symmetric');
        expect(memberOf(net, net.bob.conn.peer)).toBeDefined();
      });

      it('does not take a join that was signed for another server', async () => {
        const net = await conversation();
        await joined(net);
        claimBob(net);
        // Bob signs for his own server; the rogue one passes it on.
        const body = { op: 'join', caps: caps({ nat: 'open' }) } as const;
        const proof = signSessionOp(net.bob.identity, net.sessionId, net.bob.conn.peer, body, {
          server: net.honest.info.id,
        });
        net.toVictim.send({
          t: 'session_op',
          opId: 'o1',
          sessionId: net.sessionId,
          peer: net.bob.conn.peer,
          op: body,
          proof,
        });
        await settled(net);
        await pause();
        expect(serverOf(net)).toBe(net.honest.info.id);
      });

      it('lets a device move to another server, and then ignores the old one', async () => {
        const net = await conversation();
        await joined(net);
        claimBob(net);
        // Bob's app now signs for the rogue server, which he really is on.
        op(net, net.bob.conn.peer, { op: 'join', caps: caps() }, net.bob.identity);
        await waitFor(() => serverOf(net) === net.rogue.info.id, 3000, 'the move');
        // The server he left says he has gone, late.
        net.bob.conn.close();
        // (The rogue server goes on saying that he is on it, so he does not go offline.)
        await new Promise((r) => setTimeout(r, 1500));
        expect(memberOf(net, net.bob.conn.peer)).toBeDefined();
      });

      it('takes a join that is up to five minutes off by the clock, and not one that is more', async () => {
        const net = await conversation();
        await joined(net);
        claimBob(net);
        const body = { op: 'join', caps: caps() };
        op(net, net.bob.conn.peer, body, net.bob.identity, { at: Date.now() - 6 * 60_000 });
        op(net, net.bob.conn.peer, body, net.bob.identity, { at: Date.now() + 6 * 60_000 });
        await settled(net);
        await pause();
        expect(serverOf(net)).toBe(net.honest.info.id);
        op(net, net.bob.conn.peer, body, net.bob.identity, { at: Date.now() + 4 * 60_000 });
        await waitFor(() => serverOf(net) === net.rogue.info.id, 3000, 'the join');
      });

      it('does not take the same join twice after the device has left, and takes a later one', async () => {
        const net = await conversation();
        await joined(net);
        claimBob(net);
        const body = { op: 'join', caps: caps() };
        // (Later than Bob's own join, which came first.)
        const at = Date.now() + 1000;
        op(net, net.bob.conn.peer, body, net.bob.identity, { at });
        await waitFor(() => serverOf(net) === net.rogue.info.id, 3000, 'the join');
        op(net, net.bob.conn.peer, { op: 'leave' });
        await waitFor(() => !memberOf(net, net.bob.conn.peer), 3000, 'the leave');
        claimBob(net);
        // Said again: the same signature, which the rogue server kept.
        op(net, net.bob.conn.peer, body, net.bob.identity, { at });
        await settled(net);
        await pause();
        expect(memberOf(net, net.bob.conn.peer)).toBeUndefined();
        op(net, net.bob.conn.peer, body, net.bob.identity, { at: at + 1 });
        await waitFor(() => memberOf(net, net.bob.conn.peer), 3000, 'the later join');
      });

      it('takes an update or a report only if it is signed, for the join, and the next in line', async () => {
        const net = await conversation();
        await joined(net);
        claimBob(net);
        // (Later than Bob's own join, which came first.)
        const at = Date.now() + 1000;
        op(net, net.bob.conn.peer, { op: 'join', caps: caps() }, net.bob.identity, { at });
        await waitFor(() => serverOf(net) === net.rogue.info.id, 3000, 'the join');
        const update = (
          nat: 'open' | 'cone' | 'symmetric',
          ctx?: { since: number; n: number },
          who = net.bob.identity,
        ) => op(net, net.bob.conn.peer, { op: 'update', caps: caps({ nat }) }, who, ctx);
        const nat = () => memberOf(net, net.bob.conn.peer)!.caps.nat;
        // Not signed, signed by someone else, for another join.
        op(net, net.bob.conn.peer, { op: 'update', caps: caps({ nat: 'open' }) });
        update('open', { since: at, n: 1 }, createIdentity());
        update('open', { since: at + 5, n: 1 });
        await settled(net);
        await pause();
        expect(nat()).not.toBe('open');
        // In order; one that comes later and is older is of no account.
        update('open', { since: at, n: 2 });
        await waitFor(() => nat() === 'open', 3000, 'the update');
        update('cone', { since: at, n: 1 });
        update('cone', { since: at, n: 2 });
        await settled(net);
        await pause();
        expect(nat()).toBe('open');
      });

      it('takes a report only if it is signed, and for the join', async () => {
        const net = await conversation();
        // Alice is the better host, so that Bob has somebody else's host to report.
        await net.alice.conn.request('session.join', {
          sessionId: net.sessionId,
          caps: caps({ nat: 'open' }),
        });
        await net.bob.conn.request('session.join', {
          sessionId: net.sessionId,
          caps: caps({ nat: 'symmetric' }),
        });
        claimBob(net);
        // (Later than Bob's own join, which came first.)
        const at = Date.now() + 1000;
        op(net, net.bob.conn.peer, { op: 'join', caps: caps() }, net.bob.identity, { at });
        await waitFor(() => serverOf(net) === net.rogue.info.id, 3000, 'the join');
        const state = net.victim.sessions.ownedState(net.sessionId)!;
        expect(state.host).toBe(net.alice.conn.peer);
        const epoch = state.epoch;
        const report = { op: 'report', epoch, issue: 'host_unreachable' };
        op(net, net.bob.conn.peer, report);
        op(net, net.bob.conn.peer, report, net.bob.identity, { since: at + 5 });
        op(net, net.bob.conn.peer, report, createIdentity(), { since: at });
        await settled(net);
        await pause();
        expect(state.epoch).toBe(epoch);
        // Signed, for the join: the only other person is enough for the host to be changed.
        op(net, net.bob.conn.peer, report, net.bob.identity, { since: at });
        await waitFor(() => state.epoch > epoch, 3000, 'the vote');
      });
    });
  });
});
