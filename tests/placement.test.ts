import { describe, expect, it } from 'vitest';
import { createIdentity, signRecord } from '@crocodile/crypto';
import { recordKey } from '@crocodile/protocol';
import {
  HashRing,
  View,
  dependenciesOf,
  shardOfKey,
  shardOfPrefix,
  shardOfTerm,
  shardsOf,
} from '../packages/coordinator/src/placement';

const ids = Array.from({ length: 20 }, (_, i) => `server${String(i).padStart(2, '0')}`);

describe('placement', () => {
  it('spreads shards evenly and moves few when a server joins', () => {
    const ring = new HashRing(ids);
    const counts = new Map<string, number>();
    const shards = Array.from({ length: 4000 }, (_, i) => `user:${i}`);
    for (const s of shards) {
      const [first] = ring.owners(s, 1);
      counts.set(first!, (counts.get(first!) ?? 0) + 1);
    }
    // 200 each on average; no server gets more than about twice that.
    expect(Math.max(...counts.values())).toBeLessThan(450);
    const bigger = new HashRing([...ids, 'server20']);
    const moved = shards.filter((s) => ring.owners(s, 1)[0] !== bigger.owners(s, 1)[0]).length;
    // About 1/21 of them; nowhere near a reshuffle.
    expect(moved).toBeLessThan(400);
    // Distinct owners, and everyone when asking for more than there are.
    expect(new Set(ring.owners('user:x', 3)).size).toBe(3);
    expect(new HashRing(['a', 'b']).owners('user:x', 3)).toEqual(['a', 'b']);
  });

  it('adds full-copy servers to every placement, and small networks own everything', () => {
    const view = new View(ids, ['server07'], 3);
    expect(view.ownersOf('space:abc')).toContain('server07');
    expect(view.ownersOf('space:abc').length).toBeLessThanOrEqual(4);
    expect(new View(['a', 'b', 'c'], [], 3).ownsAll).toBe(true);
    expect(new View(ids, [], 3).ownsAll).toBe(false);
  });

  it('keeps each kind of query on one shard', () => {
    const alice = createIdentity();
    const u = alice.userId;
    const profile = signRecord(alice, 'profile', recordKey.profile(u), {
      username: 'Alice',
      encKey: alice.encPublicKey,
    });
    expect(shardsOf(profile)).toEqual([`user:${u}`, 'name:alice']);
    expect(shardOfKey(recordKey.profile(u))).toBe(`user:${u}`);
    expect(shardOfKey(recordKey.device(u, 'abcdefgh'))).toBe(`user:${u}`);
    expect(shardOfKey(recordKey.member('spacexyz', u))).toBe('space:spacexyz');
    expect(shardOfKey('invite:codecode')).toBe('invite:codecode');
    expect(shardOfPrefix(recordKey.devicePrefix(u))).toBe(`user:${u}`);
    expect(shardOfPrefix(recordKey.notePrefix(u))).toBe(`user:${u}`);
    expect(shardOfPrefix(recordKey.memberPrefix('spacexyz'))).toBe('space:spacexyz');
    expect(shardOfPrefix(recordKey.friends(u))).toBe(`user:${u}`);
    expect(shardOfPrefix('profile:')).toBeUndefined();
    expect(shardOfTerm(`member-user:${u}`)).toBe(`user:${u}`);
    expect(shardOfTerm('name:alice')).toBe('name:alice');
    expect(shardOfTerm('invite-space:spacexyz')).toBe('space:spacexyz');
    expect(shardOfTerm(`friend-of:${u}`)).toBeUndefined();
  });

  it("doesn't count a profile as its own dependency", () => {
    const alice = createIdentity();
    const profile = signRecord(alice, 'profile', recordKey.profile(alice.userId), {
      username: 'alice',
      encKey: alice.encPublicKey,
    });
    expect(dependenciesOf(profile, alice.userId)).toEqual([]);
    const device = signRecord(alice, 'device', recordKey.device(alice.userId, 'abcdefgh'), {
      userId: alice.userId,
      deviceId: 'abcdefgh',
      name: 'x',
      platform: 'bot',
      prekey: { id: 1, x25519: 'a'.repeat(43), mlkem: 'b'.repeat(1579), expiresAt: 0 },
    });
    expect(dependenciesOf(device, alice.userId)).toEqual([recordKey.profile(alice.userId)]);
  });
});
