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

function makeClient(
  net: FakeRelayNetwork,
  coordinator: Coordinator,
  opts: { canHost?: boolean; nat?: 'open' | 'cone' | 'symmetric' } = {},
) {
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
  await waitFor(
    () => client.state.link === 'connected' && client.state.me,
    5000,
    `${name} connected`,
  );
  return client;
}

const channelOf = (c: CrocodileClient, spaceId: string) =>
  c.state.spaces[spaceId]!.channels.find((ch) => ch.kind === 'text')!.id;
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
    await waitFor(
      () => alice.state.friends.incoming.includes(bob.userId),
      3000,
      'incoming request',
    );
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.friends.includes(alice.userId), 12000, 'friendship');

    // Space + invite.
    const spaceId = await alice.createSpace('Swamp');
    const code = await alice.createInvite(spaceId);
    await bob.joinWithInvite(`croc://join/${code}`);
    await waitFor(
      () => alice.state.spaces[spaceId]?.members.includes(bob.userId),
      3000,
      'member visible',
    );
    const ch = channelOf(alice, spaceId);
    await alice.openChannel(ch);
    await bob.openChannel(ch);

    const sid = sessionIds.space(spaceId);
    await waitFor(
      () =>
        alice.state.sessions[sid]?.peers.includes(bob.userId) &&
        bob.state.sessions[sid]?.peers.includes(alice.userId),
      5000,
      'relay mesh',
    );
    expect(alice.state.sessions[sid]!.host).toBe(alice.userId);
    expect(alice.state.sessions[sid]!.iAmHost).toBe(true);

    await alice.sendMessage(ch, 'hello swamp');
    await waitFor(() => bodies(bob, ch).includes('hello swamp'), 12000, 'bob receives');
    await bob.sendMessage(ch, 'hi alice');
    await waitFor(() => bodies(alice, ch).includes('hi alice'), 12000, 'alice receives');

    // Edits fold onto the original.
    const original = bob.state.messages[ch]!.find((m) => m.body === 'hello swamp')!;
    await alice.editMessage(ch, original.id, 'hello swamp!');
    await waitFor(() => bodies(bob, ch).includes('hello swamp!'), 12000, 'edit');
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
    await waitFor(() => alice.state.sessions[sid]?.peers.includes(bob.userId), 12000);
    for (let i = 0; i < 5; i++) await alice.sendMessage(ch, `msg ${i}`);

    const carol = await signUp(makeClient(net, coord), 'carol');
    await carol.joinWithInvite(code);
    await carol.openChannel(ch);
    await waitFor(() => bodies(carol, ch).length === 5, 12000, 'history');
    expect(bodies(carol, ch)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
  });

  it('delivers DMs, including ones written while the friend was offline', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');
    await alice.addFriend(bob.userId);
    await waitFor(() => bob.state.friends.incoming.includes(alice.userId), 12000);
    await bob.addFriend(alice.userId);

    const dm = await alice.openDm(bob.userId);
    await waitFor(() => bob.state.dms.includes(alice.userId), 12000, 'dm invite');
    await alice.openChannel(dm);
    await bob.openChannel(dm);
    await waitFor(() => alice.state.sessions[dm]?.peers.includes(bob.userId), 12000, 'dm connected');
    await alice.sendMessage(dm, 'psst');
    await waitFor(() => bodies(bob, dm).includes('psst'), 12000, 'dm delivered');

    // Bob goes offline; Alice writes; Bob comes back and syncs from Alice.
    const bobKv = bob.platform.kv as MemoryKeyValueStore;
    await bob.shutdown();
    await waitFor(() => alice.state.sessions[dm]?.peers.length === 0, 12000, 'bob gone');
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
    await waitFor(
      () => bodies(bob2, dm).includes('while you were away'),
      5000,
      'offline dm synced',
    );
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
    await waitFor(() => carol.state.sessions[sid]?.peers.length === 2, 12000, 'all connected');
    expect(carol.state.sessions[sid]!.host).toBe(alice.userId);
    expect(carol.state.sessions[sid]!.backup).toBe(bob.userId);

    // Alice's machine drops off the network entirely.
    net.killRelaysOf(alice.userId);
    alice.link!.stop();
    await waitFor(
      () =>
        carol.state.sessions[sid]?.host === bob.userId &&
        carol.state.sessions[sid]?.status === 'connected',
      8000,
      'failover',
    );
    await carol.sendMessage(ch, 'still here?');
    await waitFor(() => bodies(bob, ch).includes('still here?'), 12000, 'chat after failover');
  });

  it('works across two coordination servers in a mesh', async () => {
    const a = await server({ name: 'A' });
    const b = await server({ name: 'B', meshPeers: [a.url] });
    await waitFor(() => a.mesh.peerIds().length === 1, 12000, 'mesh');
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, a, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, b), 'bob');
    const spaceId = await alice.createSpace('Federated');
    const code = await alice.createInvite(spaceId);
    await waitFor(() => b.records.get(`invite:${code}`), 12000, 'invite replicated');
    await bob.joinWithInvite(code);
    const ch = channelOf(alice, spaceId);
    await bob.openChannel(ch);
    const sid = sessionIds.space(spaceId);
    await waitFor(
      () => bob.state.sessions[sid]?.peers.includes(alice.userId),
      8000,
      'cross-server relay',
    );
    await alice.sendMessage(ch, 'across the mesh');
    await waitFor(() => bodies(bob, ch).includes('across the mesh'), 12000);
    expect(bob.state.server!.info.id).toBe(b.info.id);
    expect(alice.state.server!.info.id).toBe(a.info.id);
  });
});

describe('multiple devices', () => {
  it('links a new device with a code and delivers to every device of a user', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice1 = await signUp(makeClient(net, coord, { nat: 'open' }), 'alice');
    const bob = await signUp(makeClient(net, coord), 'bob');

    // A fresh install shows a code; the signed-in device types it in.
    const alice2 = makeClient(net, coord);
    await alice2.init();
    expect(alice2.state.phase).toBe('onboarding');
    await alice2.startDeviceLink();
    const code = await waitFor(
      () => (alice2.state.linking?.role === 'new' ? alice2.state.linking.code : undefined),
      5000,
      'code',
    );
    const shownOnOld = await alice1.claimDeviceLink(code);
    const shownOnNew = await waitFor(
      () =>
        alice2.state.linking?.role === 'new' && alice2.state.linking.step === 'claimed'
          ? alice2.state.linking.securityCode
          : undefined,
      5000,
      'claimed',
    );
    expect(shownOnNew).toBe(shownOnOld);
    await alice1.confirmDeviceLink();
    await waitFor(
      () => alice2.identity?.userId === alice1.userId && alice2.state.link === 'connected',
      5000,
      'linked',
    );
    alice2.finishOnboarding();
    expect(alice2.deviceId).not.toBe(alice1.deviceId);
    await waitFor(() => alice1.state.devices.length === 2, 12000, 'device list');

    const spaceId = await alice1.createSpace('Devices');
    const code2 = await alice1.createInvite(spaceId);
    await bob.joinWithInvite(code2);
    await waitFor(() => alice2.state.spaces[spaceId], 12000, 'space on second device');
    const ch = channelOf(alice1, spaceId);
    for (const c of [alice1, alice2, bob]) await c.openChannel(ch);
    const sid = sessionIds.space(spaceId);
    await waitFor(
      () => [alice1, alice2, bob].every((c) => c.sessionFor(sid)?.peers.size === 2),
      8000,
      'three peers',
    );
    await bob.sendMessage(ch, 'to all your devices');
    await waitFor(
      () =>
        bodies(alice1, ch).includes('to all your devices') &&
        bodies(alice2, ch).includes('to all your devices'),
      5000,
    );
    await alice2.sendMessage(ch, 'from my laptop');
    await waitFor(
      () =>
        bodies(alice1, ch).includes('from my laptop') && bodies(bob, ch).includes('from my laptop'),
      5000,
    );

    // Removing a device: peers stop trusting it.
    await alice1.revokeDevice(alice2.deviceId);
    const alice2Peer = `${alice2.userId}.${alice2.deviceId}`;
    await waitFor(() => !bob.isAllowedPeer(sid, alice2Peer), 12000, 'revocation seen by bob');
    expect(bob.isAllowedPeer(sid, `${alice1.userId}.${alice1.deviceId}`)).toBe(true);
  });

  it('rejects a link when the security codes are not confirmed', async () => {
    const coord = await server();
    const net = new FakeRelayNetwork();
    const alice = await signUp(makeClient(net, coord), 'alice');
    const fresh = makeClient(net, coord);
    await fresh.init();
    await fresh.startDeviceLink();
    const code = await waitFor(
      () => (fresh.state.linking?.role === 'new' ? fresh.state.linking.code : undefined),
      5000,
    );
    await expect(alice.claimDeviceLink('WRONGCODE')).rejects.toThrow(/not valid/);
    await alice.claimDeviceLink(code);
    // Not confirmed: nothing is sent and the new device stays signed out.
    await new Promise((r) => setTimeout(r, 300));
    expect(fresh.identity).toBeNull();
    fresh.cancelDeviceLink();
  });
});
