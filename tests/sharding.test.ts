import { afterEach, describe, expect, it } from 'vitest';
import {
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator, CoordinatorConfig } from '@crocodile/coordinator';
import { createIdentity, createPrekey, sealToDevice, signRecord } from '@crocodile/crypto';
import {
  DELETED_PROFILE_NAME,
  peerIds,
  recordKey,
  sessionIds,
  utf8,
  type SignedRecord,
} from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import {
  connectUser,
  createSpace,
  expectAccepted,
  joinSpace,
  startCoordinator,
  waitFor,
  type TestUser,
} from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Fast timings, two owners per record and a sparse overlay from four servers on. */
const sharded: Partial<CoordinatorConfig> = {
  replicas: 2,
  mesh: { fullMeshMax: 3, maintainMs: 150, idleMs: 1500 },
  membership: { beaconMs: 200, liveMs: 1500, settleMs: 300 },
  distribution: { gcStableMs: 1200, gcCheckMs: 250, watchRenewMs: 1000, watchTtlMs: 3000 },
};

async function server(name: string, overrides: Partial<CoordinatorConfig> = {}) {
  const c = await startCoordinator({ name, ...sharded, ...overrides });
  cleanup.push(() => c.stop());
  return c;
}

/** n servers that each know only the one before; they find the rest through gossip. */
async function network(n: number, overrides: Partial<CoordinatorConfig> = {}) {
  const servers = [await server('S0', overrides)];
  for (let i = 1; i < n; i++)
    servers.push(await server(`S${i}`, { meshPeers: [servers[i - 1]!.url], ...overrides }));
  await converged(servers);
  return servers;
}

async function converged(servers: Coordinator[]) {
  await waitFor(
    () =>
      servers.every(
        (c) =>
          c.membership.liveIds().length === servers.length &&
          c.membership.settled.size === servers.length,
      ),
    15_000,
    'every server sees every other',
  );
}

const holders = (servers: Coordinator[], key: string) =>
  servers.filter((c) => c.store.get(key)).map((c) => c.info.id);

const owners = (servers: Coordinator[], record: SignedRecord) =>
  servers[0]!.membership.settled.placement(record).sort();

async function user(c: Coordinator, name?: string) {
  const u = await connectUser(c, createIdentity(), name);
  cleanup.push(() => u.conn.close());
  return u;
}

async function put(u: TestUser, record: SignedRecord) {
  expectAccepted(await u.conn.request('records.put', { record }));
}

function makeClient(net: FakeRelayNetwork, coordinator: Coordinator) {
  const platform: PlatformAdapter = {
    platform: 'desktop',
    appVersion: 'test',
    kv: new MemoryKeyValueStore(),
    messages: new MemoryMessageStore(),
    relay: net.adapter(),
    capabilities: async () => ({ nat: 'cone', cpuCores: 8 }),
  };
  const client = new CrocodileClient(platform, {
    directories: [],
    preferredServers: [coordinator.url],
    transportFactory: net.transportFactory(),
    log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
  });
  cleanup.push(() => client.shutdown());
  return client;
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 8000, name);
  return client;
}

describe('sharded records', () => {
  it('keeps each record on its owners, and every server can read it', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId, space, code } = await createSpace(alice, 'Swamp');
    const readers = await Promise.all(servers.map((c) => user(c)));
    // Readable through any server, owner or not (the invite reaches the
    // owners of its code a moment after the owners of its space).
    const keys = [space.key, `invite:${code}`].sort();
    for (const r of readers) {
      let got: string[] = [];
      for (const start = Date.now(); Date.now() - start < 3000;) {
        const res = await r.conn.request('records.get', { keys });
        got = res.records.map((x) => x.key).sort();
        if (got.join() === keys.join()) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      expect(got).toEqual(keys);
    }
    // Stored by its owners, and once things settle, by nobody else.
    await waitFor(
      () => holders(servers, space.key).sort().join() === owners(servers, space).join(),
      8000,
      'space only on its owners',
    );
    expect(owners(servers, space).length).toBeLessThanOrEqual(4);
    // A search by name and a member list go to the shards that hold them.
    const found = await readers[5]!.conn.request('users.search', { query: 'alice' });
    expect(found.profiles.map((p) => p.key)).toEqual([recordKey.profile(alice.identity.userId)]);
    await joinSpace(readers[3]!, spaceId, code);
    const members = await readers[4]!.conn.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    expect(members.records).toHaveLength(2);
    const mine = await readers[3]!.conn.request('spaces.mine', {});
    expect(mine.spaces.map((s) => s.key)).toEqual([space.key]);
  });

  it('keeps the overlay sparse, and still reaches every server', async () => {
    const servers = await network(12);
    // Direct links that were only needed for a moment close again.
    await new Promise((r) => setTimeout(r, 2500));
    const links = servers.map((c) => c.mesh.peerIds().length);
    expect(Math.max(...links)).toBeLessThan(11);
    // Presence still travels between servers that aren't linked.
    const far = servers.find((c) => !c.mesh.peerIds().includes(servers[0]!.info.id))!;
    const watcher = await user(servers[0]!);
    const target = await user(far);
    const { presence } = await watcher.conn.request('presence.subscribe', {
      userIds: [target.identity.userId],
    });
    expect(presence[0]!.status).toBe('online');
  });

  it('notifies clients of changes to records their server does not own', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const watchers = await Promise.all(servers.map((c) => user(c)));
    const key = recordKey.profile(alice.identity.userId);
    for (const w of watchers) await w.conn.request('records.subscribe', { prefixes: [key] });
    await new Promise((r) => setTimeout(r, 300));
    const renamed = signRecord(alice.identity, 'profile', key, {
      username: 'alice2',
      encKey: alice.identity.encPublicKey,
    });
    await put(alice, renamed);
    for (const w of watchers) {
      await waitFor(
        () =>
          w.events.some(
            (e) =>
              e.ev === 'record' && (e.d as { record: SignedRecord }).record.sig === renamed.sig,
          ),
        5000,
        'pushed to a watcher',
      );
    }
    // The old name's shard was told too, so it no longer finds her.
    const byOld = await watchers[2]!.conn.request('users.search', { query: 'alice' });
    expect(byOld.profiles).toEqual([]);
  });

  it('moves records to new owners as servers join, and drops copies no longer owned', async () => {
    const first = await network(3);
    const alice = await user(first[0]!, 'alice');
    const written: SignedRecord[] = [];
    for (let i = 0; i < 12; i++) {
      const { space } = await createSpace(alice, `Space ${i}`);
      written.push(space);
    }
    const more = [
      await server('S3', { meshPeers: [first[0]!.url] }),
      await server('S4', { meshPeers: [first[1]!.url] }),
      await server('S5', { meshPeers: [first[2]!.url] }),
    ];
    const servers = [...first, ...more];
    await converged(servers);
    for (const r of written) {
      await waitFor(
        () => holders(servers, r.key).sort().join() === owners(servers, r).join(),
        10_000,
        `${r.key} on exactly its owners`,
      );
    }
    // Some records really did move to the new servers.
    expect(written.some((r) => more.some((c) => c.store.get(r.key)))).toBe(true);
  });

  it('keeps records when an owner goes away', async () => {
    const servers = await network(5);
    const alice = await user(servers[0]!, 'alice');
    const written: SignedRecord[] = [];
    for (let i = 0; i < 8; i++) written.push((await createSpace(alice, `Space ${i}`)).space);
    // Take down a server that owns some of them (not the one Alice uses).
    const victim = servers.slice(1).find((c) => written.some((r) => c.store.get(r.key)))!;
    await victim.stop();
    const rest = servers.filter((c) => c !== victim);
    await converged(rest);
    for (const r of written) {
      await waitFor(
        () => holders(rest, r.key).length >= 2,
        10_000,
        `${r.key} copied to a new owner`,
      );
    }
    const reader = await user(rest[rest.length - 1]!);
    const got = await reader.conn.request('records.get', { keys: written.map((r) => r.key) });
    expect(got.records).toHaveLength(written.length);
  });

  it('repairs a copy that went missing on one owner', async () => {
    const servers = await network(5);
    const alice = await user(servers[0]!, 'alice');
    const { space } = await createSpace(alice, 'Swamp');
    await waitFor(
      () => holders(servers, space.key).sort().join() === owners(servers, space).join(),
      8000,
      'stored by its owners',
    );
    const [lost, kept] = owners(servers, space).map((id) => servers.find((c) => c.info.id === id)!);
    lost!.store.delete(space.key);
    // Nothing else would bring it back; comparing notes with another owner does.
    await lost!.dist.repair(kept!.info.id);
    expect(lost!.store.get(space.key)?.sig).toBe(space.sig);
    // And the other way round: an owner that has it sends it.
    lost!.store.delete(space.key);
    await kept!.dist.repair(lost!.info.id);
    await waitFor(() => lost!.store.get(space.key), 3000, 'sent back');
  });

  it('a server that keeps a full copy has everything', async () => {
    const servers = await network(4);
    const archive = await server('archive', { meshPeers: [servers[0]!.url], storeAll: true });
    const all = [...servers, archive];
    await converged(all);
    await waitFor(
      () => servers.every((c) => c.membership.settled.full.includes(archive.info.id)),
      5000,
      'everyone knows the archive keeps everything',
    );
    const alice = await user(servers[1]!, 'alice');
    const spaces = [];
    for (let i = 0; i < 6; i++) spaces.push((await createSpace(alice, `S${i}`)).space);
    for (const s of spaces) await waitFor(() => archive.store.get(s.key), 5000, 'on the archive');
  });

  it('refuses servers that speak the old protocol', async () => {
    const a = await server('new');
    const ws = new WebSocket(a.url.replace('http', 'ws') + '/v1/federation');
    const closed = new Promise<string>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.reason)),
    );
    ws.addEventListener('message', (e) => {
      const hello = JSON.parse(String(e.data)) as { t: string };
      if (hello.t !== 'fed_hello') return;
      // An old server's hello: no protocol field.
      const old = createIdentity();
      ws.send(
        JSON.stringify({
          t: 'fed_hello',
          server: { ...a.info, id: old.userId, key: old.publicKey, url: 'http://127.0.0.1:1' },
          challenge: 'c',
          channel: { x25519: '', mlkem: '' },
        }),
      );
    });
    expect(await closed).toMatch(/protocol 2 required/);
  });
});

describe('across servers that are not linked', () => {
  /** Two servers of a sparse network with no link between them. */
  function apart(servers: Coordinator[]) {
    for (const x of servers)
      for (const y of servers)
        if (x !== y && !x.mesh.peerIds().includes(y.info.id)) return [x, y] as const;
    throw new Error('every server is linked to every other');
  }

  it('delivers mail held on one server to a device that connects to another', async () => {
    const servers = await network(12);
    await new Promise((r) => setTimeout(r, 2000));
    const [x, y] = apart(servers);
    const bobId = createIdentity();
    let bob = await connectUser(y, bobId, 'bob');
    const deviceId = peerIds.device(bob.conn.peer);
    const prekey = createPrekey().bundle;
    await put(
      bob,
      signRecord(bobId, 'device', recordKey.device(bobId.userId, deviceId), {
        userId: bobId.userId,
        deviceId,
        name: 'laptop',
        platform: 'bot',
        prekey,
      }),
    );
    bob.conn.close();
    await waitFor(() => y.presence.localOf(bobId.userId).length === 0, 3000, 'bob offline');
    const alice = await user(x, 'alice');
    const box = sealToDevice(
      alice.identity,
      peerIds.device(alice.conn.peer),
      { peer: bob.conn.peer, prekey },
      utf8.encode('{"type":"mail","messages":[]}'),
    );
    const { ids } = await alice.conn.request('mail.put', { items: [{ to: bob.conn.peer, box }] });
    expect(x.store.mailCount({ toUser: bobId.userId })).toBe(1);

    bob = await connectUser(y, bobId, 'bob', deviceId);
    cleanup.push(() => bob.conn.close());
    await bob.conn.request('mail.fetch', {});
    await waitFor(
      () => bob.events.some((e) => e.ev === 'mail'),
      5000,
      'mail from the other server',
    );
    await bob.conn.request('mail.ack', { ids });
    await waitFor(() => x.store.mailCount({}) === 0, 5000, 'acknowledged everywhere');
  });

  it('finds a device-link code opened on another server', async () => {
    const servers = await network(12);
    await new Promise((r) => setTimeout(r, 2000));
    const [x, y] = apart(servers);
    const fresh = await user(x);
    const { code } = await fresh.conn.request('link.open', {
      encKey: createIdentity().encPublicKey,
    });
    const existing = await user(y);
    const found = await existing.conn.request('link.claim', { code });
    expect(found.peer).toBe(fresh.conn.peer);
  });

  it('erases a deleted account everywhere its records live', async () => {
    const servers = await network(6);
    const alice = await user(servers[0]!, 'alice');
    const { spaceId, code } = await createSpace(alice, 'Swamp');
    const bob = await user(servers[4]!, 'bob');
    await joinSpace(bob, spaceId, code);
    const memberKey = recordKey.member(spaceId, bob.identity.userId);
    await waitFor(() => holders(servers, memberKey).length >= 2, 5000, 'membership stored');
    await put(
      bob,
      signRecord(bob.identity, 'profile', recordKey.profile(bob.identity.userId), {
        username: DELETED_PROFILE_NAME,
        encKey: bob.identity.encPublicKey,
        deleted: true,
      }),
    );
    await waitFor(() => holders(servers, memberKey).length === 0, 8000, 'membership erased');
    const reader = await user(servers[2]!);
    const { records } = await reader.conn.request('records.list', {
      prefix: recordKey.memberPrefix(spaceId),
    });
    expect(records.map((r) => r.key)).toEqual([recordKey.member(spaceId, alice.identity.userId)]);
  });
});

describe('the app across a sharded network', () => {
  it('befriends, shares a space and chats with people on other servers', async () => {
    const servers = await network(6);
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, servers[0]!), 'alice');
    const bob = await signUp(makeClient(net, servers[3]!), 'bob');
    const carol = await signUp(makeClient(net, servers[5]!), 'carol');

    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12_000, 'request');
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12_000, 'friends');

    const spaceId = await alice.createSpace('Delta');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    await carol.joinWithInvite(code);
    for (const c of [alice, bob, carol])
      await waitFor(() => c.state.spaces[spaceId]?.members.length === 3, 12_000, 'members');

    const ch = alice.state.spaces[spaceId]!.channels.find((x) => x.kind === 'text')!.id;
    for (const c of [alice, bob, carol]) await c.openChannel(ch);
    await waitFor(
      () => alice.state.sessions[sessionIds.space(spaceId)]?.peers.length === 2,
      12_000,
      'session up',
    );
    await carol.sendMessage(ch, 'hello from the edge');
    for (const c of [alice, bob]) {
      await waitFor(
        () => (c.state.messages[ch] ?? []).some((m) => m.body === 'hello from the edge'),
        12_000,
        'message',
      );
    }
    // Presence across servers.
    await waitFor(() => alice.state.presence[bob.userId] === 'online', 8000, 'presence');
  });
});
