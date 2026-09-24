import { afterEach, describe, expect, it } from 'vitest';
import {
  CrocodileClient,
  MemoryKeyValueStore,
  MemoryMessageStore,
  type PlatformAdapter,
} from '@crocodile/client-core';
import type { Coordinator } from '@crocodile/coordinator';
import { sessionIds } from '@crocodile/protocol';
import { FakeRelayNetwork } from './helpers/fake-relay';
import { startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(overrides = {}) {
  const c = await startCoordinator(overrides);
  cleanup.push(() => c.stop());
  return c;
}

function makeClient(net: FakeRelayNetwork, coordinator: Coordinator, opts: { canHost?: boolean; nat?: 'open' | 'cone' | 'symmetric' } = {}) {
  const platform: PlatformAdapter = {
    platform: opts.canHost === false ? 'web' : 'desktop',
    appVersion: 'test',
    kv: new MemoryKeyValueStore(),
    messages: new MemoryMessageStore(),
    ...(opts.canHost === false ? {} : { relay: net.adapter() }),
    capabilities: async () => ({ nat: opts.nat ?? 'cone', cpuCores: 8 }),
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
  await waitFor(() => client.state.link === 'connected' && client.state.me, 5000, `${name} connected`);
  return client;
}

const channelOf = (c: CrocodileClient, spaceId: string) => c.state.spaces[spaceId]!.channels.find((ch) => ch.kind === 'text')!.id;
const bodies = (c: CrocodileClient, ch: string) => (c.state.messages[ch] ?? []).map((m) => m.body);

describe('client', () => {
  it('onboards, befriends and chats end-to-end in a space', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');

    // Friends: request, then accept.
    const found = await bob.searchUsers(`alice#${alice.state.me!.tag}`);
    expect(found.map((p) => p.userId)).toEqual([alice.userId]);
    await bob.addFriend(alice.userId);
    await waitFor(() => alice.state.friends.incoming.includes(bob.userId), 3000, 'incoming request');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.friends.includes(alice.userId), 3000, 'friendship');

    // Space + invite.
    const spaceId = await alice.createSpace('Swamp');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(`croc://join/${code}`);
    await waitFor(() => alice.state.spaces[spaceId]?.members.includes(bob.userId), 3000, 'member visible');
    const ch = channelOf(alice, spaceId);
    await alice.openChannel(ch);
    await bob.openChannel(ch);

    const sid = sessionIds.space(spaceId);
    await waitFor(() => alice.state.sessions[sid]?.peers.includes(bob.userId) && bob.state.sessions[sid]?.peers.includes(alice.userId), 5000, 'relay mesh');
    expect(alice.state.sessions[sid]!.host).toBe(alice.userId);
    expect(alice.state.sessions[sid]!.iAmHost).toBe(true);

    await alice.sendMessage(ch, 'hello swamp');
    await waitFor(() => bodies(bob, ch).includes('hello swamp'), 3000, 'bob receives');
    await bob.sendMessage(ch, 'hi alice');
    await waitFor(() => bodies(alice, ch).includes('hi alice'), 3000, 'alice receives');

    // Edits fold onto the original.
    const original = bob.state.messages[ch]!.find((m) => m.body === 'hello swamp')!;
    await alice.editMessage(ch, original.id, 'hello swamp!');
    await waitFor(() => bodies(bob, ch).includes('hello swamp!'), 3000, 'edit');
    expect(bob.state.messages[ch]!.find((m) => m.id === original.id)!.edited).toBe(true);
  });

  it('syncs history to members who join later, peer to peer', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    const spaceId = await alice.createSpace('History');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    const sid = sessionIds.space(spaceId);
    await waitFor(() => alice.state.sessions[sid]?.peers.includes(bob.userId), 5000);
    for (let i = 0; i < 5; i++) await alice.sendMessage(ch, `msg ${i}`);

    const carol = await signUp(makeClient(net, coord), 'carol');
    await carol.joinWithInvite(code);
    await carol.openChannel(ch);
    await waitFor(() => bodies(carol, ch).length === 5, 5000, 'history');
    expect(bodies(carol, ch)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
  });

  it('delivers DMs, including ones written while the friend was offline', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 3000);
    await bob.addFriend(alice.userId);

    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 3000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    await waitFor(() => alice.state.sessions[dm]?.peers.includes(bob.userId), 5000, 'dm connected');
    await alice.sendMessage(dm, 'psst');
    await waitFor(() => bodies(bob, dm).includes('psst'), 3000, 'dm delivered');

    // Bob goes offline; Alice writes; Bob comes back and syncs from Alice.
    const bobKv = (bob.platform.kv as MemoryKeyValueStore);
    await bob.shutdown();
    await waitFor(() => alice.state.sessions[dm]?.peers.length === 0, 5000, 'bob gone');
    await alice.sendMessage(dm, 'while you were away');
    expect(alice.state.messages[dm]!.at(-1)!.pending).toBe(true);

    const bob2 = new CrocodileClient(
      { ...bob.platform, kv: bobKv },
      { directories: [], preferredServers: [coord.url], transportFactory: net.transportFactory() },
    );
    cleanup.push(() => bob2.shutdown());
    await bob2.init();
    await bob2.openDm(alice.userId);
    await bob2.openChannel(dm);
    await waitFor(() => bodies(bob2, dm).includes('while you were away'), 5000, 'offline dm synced');
  });

  it('fails over to the backup host and keeps chatting', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord, { nat: 'cone' }), 'bob');
    const carol = await signUp(makeClient(net, coord, { canHost: false }), 'carol');
    const spaceId = await alice.createSpace('Failover');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(code);
    await carol.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    const sid = sessionIds.space(spaceId);
    await bob.openChannel(ch);
    await carol.openChannel(ch);
    await waitFor(() => carol.state.sessions[sid]?.peers.length === 2, 5000, 'all connected');
    expect(carol.state.sessions[sid]!.host).toBe(alice.userId);
    expect(carol.state.sessions[sid]!.backup).toBe(bob.userId);

    // Alice's machine drops off the network entirely.
    net.killRelaysOf(alice.userId);
    alice.link!.stop();
    await waitFor(() => carol.state.sessions[sid]?.host === bob.userId && carol.state.sessions[sid]?.status === 'connected', 8000, 'failover');
    await carol.sendMessage(ch, 'still here?');
    await waitFor(() => bodies(bob, ch).includes('still here?'), 3000, 'chat after failover');
  });

  it('works across two coordination servers in a mesh', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().length === 1, 5000, 'mesh');
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, a, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, b), 'bob');
    const spaceId = await alice.createSpace('Federated');
    const code = await alice.createInvite(spaceId);
    await waitFor(() => b.records.get(`invite:${code}`), 3000, 'invite replicated');
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    await bob.openChannel(ch);
    const sid = sessionIds.space(spaceId);
    await waitFor(() => bob.state.sessions[sid]?.peers.includes(alice.userId), 8000, 'cross-server relay');
    await alice.sendMessage(ch, 'across the mesh');
    await waitFor(() => bodies(bob, ch).includes('across the mesh'), 3000);
    expect(bob.state.server!.info.id).toBe(b.info.id);
    expect(alice.state.server!.info.id).toBe(a.info.id);
  });
});
