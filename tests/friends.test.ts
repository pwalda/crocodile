import { afterEach, describe, expect, it } from 'vitest';
import {
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { createIdentity, encodeRecoveryKey, sealForSelf, signRecord } from '@crocodile/crypto';
import { utf8 } from '@crocodile/protocol';
import { recordKey, type SignedRecord } from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { connectUser, expectAccepted, startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

async function mesh() {
  const a = await server({ name: 'A' });
  const b = await server({ name: 'B', meshPeers: [a.url] });
  await waitFor(() => a.mesh.peerIds().length === 1, 12000, 'mesh');
  return { a, b };
}

function makeClient(net: FakeRelayNetwork, coordinator: Coordinator, platform?: PlatformAdapter) {
  const client = new CrocodileClient(
    platform ?? {
      platform: 'desktop',
      appVersion: 'test',
      kv: new MemoryKeyValueStore(),
      messages: new MemoryMessageStore(),
      relay: net.adapter(),
      capabilities: async () => ({ nat: 'cone', cpuCores: 8 }),
    },
    {
      directories: [],
      preferredServers: [coordinator.url],
      transportFactory: net.transportFactory(),
      log: process.env.DBG ? (m, e) => console.log('client', m, JSON.stringify(e)) : undefined,
    },
  );
  cleanup.push(() => client.shutdown());
  return client;
}

async function signUp(client: CrocodileClient, name: string) {
  await client.init();
  await client.createAccount(name);
  await waitFor(() => client.state.link === 'connected' && client.state.me, 8000, name);
  return client;
}

/** Same device (same storage), started again. */
async function restart(net: FakeRelayNetwork, old: CrocodileClient, coordinator: Coordinator) {
  await old.shutdown();
  const c = makeClient(net, coordinator, old.platform);
  await c.init();
  await waitFor(() => c.state.link === 'connected', 8000, 'reconnected');
  return c;
}

/** The same account signed in on another device. */
async function otherDevice(net: FakeRelayNetwork, of: CrocodileClient, coordinator: Coordinator) {
  const c = makeClient(net, coordinator);
  await c.init();
  await c.restoreAccount(of.recoveryKey());
  await waitFor(() => c.state.link === 'connected', 8000, 'second device connected');
  return c;
}

const notes = (c: Coordinator) => c.store.listPrefix('note:', 1000);

describe('friends', () => {
  it('keeps who is friends with whom from the servers, across the mesh', async () => {
    const { a, b } = await mesh();
    const net = new FakeRelayNetwork();
    const seen: SignedRecord[] = [];
    for (const c of [a, b]) c.records.onAccepted((r) => seen.push(r));
    const alice = await signUp(makeClient(net, a), 'alice');
    const bob = await signUp(makeClient(net, b), 'bob');
    await waitFor(
      () => a.records.get(recordKey.device(bob.userId, bob.deviceId)),
      8000,
      'bob replicated',
    );

    await alice.addFriend(bob.userId);
    expect(alice.state.friends.outgoing).toEqual([bob.userId]);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000, 'request');
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 12000, 'accepted');
    expect(bob.state.friends.friends).toEqual([alice.userId]);

    // Everything either server stored or passed on: the lists are sealed and
    // the notes don't name their sender.
    const lists = seen.filter((r) => r.kind === 'friends');
    const sentNotes = seen.filter(
      (r) => r.kind === 'note' && !(r.body as { deleted?: boolean }).deleted,
    );
    expect(lists.length).toBeGreaterThan(0);
    expect(sentNotes.length).toBeGreaterThanOrEqual(2);
    for (const r of lists) {
      const other = r.key === recordKey.friends(alice.userId) ? bob : alice;
      expect(JSON.stringify(r)).not.toContain(other.userId);
    }
    for (const r of sentNotes) {
      const to = r.key.split(':')[1];
      const from = to === alice.userId ? bob : alice;
      expect(JSON.stringify(r)).not.toContain(from.userId);
      expect(JSON.stringify(r)).not.toContain(from.identity!.publicKey);
    }
    for (const c of [a, b]) {
      expect(c.store.countByTerm(`friend-of:${alice.userId}`)).toBe(0);
      expect(c.store.countByTerm(`friend-of:${bob.userId}`)).toBe(0);
    }
    // Read notes are deleted everywhere.
    for (const c of [a, b]) {
      await waitFor(
        () => notes(c).every((n) => (n.body as { deleted?: boolean }).deleted),
        8000,
        `notes deleted on ${c.config.name}`,
      );
    }
  });

  it('reaches someone who is offline, and every device of theirs', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    let bob = await signUp(makeClient(net, coord), 'bob');
    const bobId = bob.userId;
    await waitFor(() => coord.records.get(recordKey.device(bobId, bob.deviceId)), 5000, 'device');
    await bob.shutdown();
    await waitFor(() => coord.presence.localOf(bobId).length === 0, 5000, 'bob offline');

    await alice.addFriend(bobId);
    await waitFor(() => notes(coord).length === 1, 5000, 'note stored');
    bob = await restart(net, bob, coord);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 8000, 'request');
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bobId), 8000, 'accepted');

    // A device linked afterwards gets the list from the sealed record.
    const laptop = await otherDevice(net, bob, coord);
    await waitFor(() => laptop.state.friends.friends.includes(alice.userId), 8000, 'laptop list');
    // And a change on it reaches the first device and Alice.
    await laptop.removeFriend(alice.userId);
    await waitFor(() => !bob.state.friends.friends.includes(alice.userId), 8000, 'bob synced');
    await waitFor(() => alice.state.friends.outgoing.includes(bobId), 8000, 'alice told');
    expect(bob.state.friends.incoming).toEqual([alice.userId]);
  });

  it('sends a request again once the person has a device to send it to', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    // Bob's account exists, but no app of his has signed in yet.
    const identity = createIdentity();
    const raw = await connectUser(coord, identity, 'bob');
    raw.conn.close();
    await waitFor(() => coord.presence.localOf(identity.userId).length === 0, 5000, 'offline');
    await alice.addFriend(identity.userId);
    expect(notes(coord)).toEqual([]);

    const bob = makeClient(net, coord);
    await bob.init();
    await bob.restoreAccount(encodeRecoveryKey(identity.seed));
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000, 'request');
  });

  it('enforces blocks on the blocking side', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 8000, 'request');
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 8000, 'friends');

    await alice.block(bob.userId);
    expect(alice.state.friends.blocked).toEqual([bob.userId]);
    // Bob is told she no longer lists him, not that she blocked him.
    await waitFor(() => bob.state.friends.outgoing.includes(alice.userId), 8000, 'bob told');

    // The server can't tell, so it lets Bob open the conversation; her app ignores it.
    const dm = await bob.openDm(alice.userId);
    await bob.openChannel(dm);
    await bob.sendMessage(dm, 'hello?');
    await new Promise((r) => setTimeout(r, 1500));
    expect(alice.state.dms).not.toContain(bob.userId);
    expect(alice.state.messages[dm] ?? []).toEqual([]);

    // Unblocked: his standing request shows again.
    await alice.unblock(bob.userId);
    expect(alice.state.friends.incoming).toEqual([bob.userId]);
  });

  it('moves a readable list from an older app into a sealed one', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const bob = await signUp(makeClient(net, coord), 'bob');
    const carol = createIdentity();
    // Alice, still on an older app, lists Bob and blocks Carol in the open.
    const identity = createIdentity();
    const old = await connectUser(coord, identity, 'alice');
    const key = recordKey.friends(identity.userId);
    expectAccepted(
      await old.conn.request('records.put', {
        record: signRecord(identity, 'friends', key, {
          friends: [bob.userId],
          blocked: [carol.userId],
        }),
      }),
    );
    // Bob's app still understands requests from older apps.
    await waitFor(() => bob.state.friends.incoming.includes(identity.userId), 8000, 'old request');
    old.conn.close();

    // Alice updates.
    const alice = makeClient(net, coord);
    await alice.init();
    await alice.restoreAccount(encodeRecoveryKey(identity.seed));
    await waitFor(
      () => 'sealed' in ((coord.records.get(key)?.body ?? {}) as object),
      8000,
      'list sealed',
    );
    expect(JSON.stringify(coord.records.get(key))).not.toContain(bob.userId);
    expect(JSON.stringify(coord.records.get(key))).not.toContain(carol.userId);
    expect(coord.store.countByTerm(`friend-of:${bob.userId}`)).toBe(0);
    expect(alice.state.friends.outgoing).toEqual([bob.userId]);
    expect(alice.state.friends.blocked).toEqual([carol.userId]);

    await bob.addFriend(identity.userId);
    await waitFor(() => alice.state.friends.friends.includes(bob.userId), 8000, 'alice sees');
    await waitFor(() => bob.state.friends.friends.includes(identity.userId), 8000, 'bob sees');
  });

  it('catches up when a note was lost', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    let bob = await signUp(makeClient(net, coord), 'bob');
    const bobId = bob.userId;
    await waitFor(() => coord.records.get(recordKey.device(bobId, bob.deviceId)), 5000, 'device');
    await bob.shutdown();
    await waitFor(() => coord.presence.localOf(bobId).length === 0, 5000, 'bob offline');
    await alice.addFriend(bobId);
    // Her request never reaches him.
    const [lost] = await waitFor(() => notes(coord).length === 1 && notes(coord), 5000, 'note');
    coord.store.delete(lost!.key);
    bob = await restart(net, bob, coord);
    await new Promise((r) => setTimeout(r, 300));
    expect(bob.state.friends.incoming).toEqual([]);

    // He asks her himself; his note says he thinks she doesn't list him, so
    // her app tells him again.
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.friends.includes(bobId), 8000, 'alice');
    await waitFor(() => bob.state.friends.friends.includes(alice.userId), 8000, 'bob');
  });

  it('keeps changes made offline and stores them on the next connection', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    let alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    alice.link!.stop();
    await waitFor(() => alice.state.link !== 'connected', 5000, 'alice offline');
    await alice.addFriend(bob.userId);
    expect(alice.state.friends.outgoing).toEqual([bob.userId]);
    expect(bob.state.friends.incoming).toEqual([]);
    alice = await restart(net, alice, coord);
    expect(alice.state.friends.outgoing).toEqual([bob.userId]);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 8000, 'request');
  });

  it("doesn't overwrite a list it can't read", async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    // A later version of the app stored the list in a form this one doesn't know.
    const key = recordKey.friends(alice.userId);
    const future = signRecord(alice.identity!, 'friends', key, {
      sealed: sealForSelf(alice.identity!, 'friends', utf8.encode('\u0009future'), key),
    });
    alice.records.ingest(future);
    expectAccepted(await alice.link!.request('records.put', { record: future }));
    await expect(alice.addFriend(bob.userId)).rejects.toThrow(/newer version/);
    expect(coord.records.get(key)?.sig).toBe(future.sig);
  });
});
