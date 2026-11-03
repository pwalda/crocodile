import { describe, expect, it } from 'vitest';
import {
  createIdentity,
  emptyRosterHash,
  newTicket,
  signRecord,
  signRoster,
  signSpaceAuthority,
  signTicketUse,
  spaceIdFor,
} from '@crocodile/crypto';
import { recordKey } from '@crocodile/protocol';
import {
  HashRing,
  View,
  dependenciesOf,
  homeShardOf,
  rosterKeyOfMember,
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

  it('counts the invite a membership was made with, whether it names a code or carries a ticket', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const spaceId = spaceIdFor(alice.publicKey, 'nonce-nonce');
    const ticket = newTicket();
    const invite = signRecord(alice, 'invite', recordKey.invite(ticket.tid), {
      spaceId,
      code: ticket.tid,
      tpub: ticket.tpub,
      expiresAt: Date.now() + 3600_000,
    });
    const key = recordKey.member(spaceId, bob.userId);
    const withTicket = signRecord(bob, 'member', key, {
      spaceId,
      userId: bob.userId,
      ticket: { invite, proof: signTicketUse(ticket, spaceId, bob.userId) },
    });
    const withCode = signRecord(bob, 'member', key, {
      spaceId,
      userId: bob.userId,
      inviteCode: 'abcdefgh',
    });
    const wanted = [recordKey.profile(bob.userId), recordKey.space(spaceId)];
    expect(dependenciesOf(withTicket, bob.userId)).toEqual([
      ...wanted,
      recordKey.invite(ticket.tid),
    ]);
    expect(dependenciesOf(withCode, bob.userId)).toEqual([...wanted, recordKey.invite('abcdefgh')]);
    // Nothing is looked up under what is not the name of an invite.
    const odd = { ...withTicket, body: { ...withTicket.body, inviteCode: '' } };
    expect(dependenciesOf(odd, bob.userId)).toEqual([...wanted, recordKey.invite(ticket.tid)]);
    const long = {
      ...withTicket,
      body: { spaceId, userId: bob.userId, inviteCode: 'x'.repeat(500) },
    };
    expect(dependenciesOf(long, bob.userId)).toEqual(wanted);
  });

  it('keeps the roster of a space with the space, and asks for it only where a space names one', () => {
    const owner = createIdentity();
    const bob = createIdentity();
    const nonce = 'roster-nonce';
    const spaceId = spaceIdFor(owner.publicKey, nonce);
    const listed = signRoster(owner, spaceId, [bob.userId]);
    const body = {
      name: 'Swamp',
      owner: owner.userId,
      nonce,
      admins: [],
      bans: [],
      channels: [],
    };
    const key = recordKey.space(spaceId);
    const space = (roster?: string) =>
      signRecord(owner, 'space', key, {
        ...body,
        ...(roster
          ? {
              authority: signSpaceAuthority(owner, spaceId, [], 1, undefined, undefined, roster),
            }
          : {}),
      });
    expect(dependenciesOf(listed.record, owner.userId)).toEqual([
      recordKey.profile(owner.userId),
      recordKey.space(spaceId),
    ]);
    expect(shardsOf(listed.record)).toEqual([`space:${spaceId}`]);
    expect(homeShardOf(listed.record)).toBe(`space:${spaceId}`);
    expect(shardOfKey(listed.record.key)).toBe(`space:${spaceId}`);
    expect(shardOfPrefix(listed.record.key)).toBe(`space:${spaceId}`);
    const old = signRecord(bob, 'member', recordKey.member(spaceId, bob.userId), {
      spaceId,
      userId: bob.userId,
      inviteCode: 'abcdefgh',
    });
    expect(rosterKeyOfMember(old, space(listed.hash))).toBe(recordKey.roster(spaceId));
    // Not where the space names none, or a roster of nobody (which has no record), or the
    // space is not known yet; nor for a membership by a ticket, or one that is left.
    expect(rosterKeyOfMember(old, space())).toBeUndefined();
    expect(rosterKeyOfMember(old, space(emptyRosterHash(spaceId)))).toBeUndefined();
    expect(rosterKeyOfMember(old, undefined)).toBeUndefined();
    const left = signRecord(bob, 'member', old.key, { spaceId, userId: bob.userId, left: true });
    expect(rosterKeyOfMember(left, space(listed.hash))).toBeUndefined();
    expect(rosterKeyOfMember(space(), space(listed.hash))).toBeUndefined();
  });
});
