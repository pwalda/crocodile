import { describe, expect, it } from 'vitest';
import {
  createIdentity,
  inviteCommitment,
  signRecord,
  signRoster,
  signSpaceAuthority,
  spaceIdFor,
  type Identity,
} from '@crocodile/crypto';
import { recordKey, type SignedRecord } from '@crocodile/protocol';
import { MemoryKeyValueStore } from '../src';
import { RecordCache } from '../src/records-cache';

const member = (id: Identity, spaceId: string) =>
  signRecord(id, 'member', recordKey.member(spaceId, id.userId), { spaceId, userId: id.userId });

const profile = (id: Identity) =>
  signRecord(id, 'profile', recordKey.profile(id.userId), {
    username: `u${id.userId.slice(0, 6)}`,
    encKey: id.encPublicKey,
  });

describe('records waiting for one they depend on', () => {
  it('a new record retries only what waits for it', () => {
    const cache = new RecordCache(new MemoryKeyValueStore());
    // Memberships of spaces we haven't got (yet).
    const owners = Array.from({ length: 400 }, () => createIdentity());
    for (const [i, id] of owners.entries())
      cache.ingest(member(id, spaceIdFor(id.publicKey, `nonce-of-${i}`)), false);

    const map = (cache as unknown as { map: Map<string, SignedRecord> }).map;
    const get = map.get.bind(map);
    let lookups = 0;
    map.get = (k: string) => (lookups++, get(k));
    expect(cache.ingest(profile(createIdentity()), false)).toBe(true);
    // Checking one profile, not 400 memberships again.
    expect(lookups).toBeLessThan(10);
    expect(cache.waitingCount).toBe(400);

    // When a space arrives, its owner's membership gets in.
    const owner = owners[0]!;
    const spaceId = spaceIdFor(owner.publicKey, 'nonce-of-0');
    const space = signRecord(owner, 'space', recordKey.space(spaceId), {
      name: 'Space',
      owner: owner.userId,
      nonce: 'nonce-of-0',
      admins: [],
      bans: [],
      channels: [],
    });
    expect(cache.ingest(space, false)).toBe(true);
    expect(cache.get(recordKey.member(spaceId, owner.userId))).toBeDefined();
    expect(cache.waitingCount).toBe(399);
  });

  it('a membership of the older kind waits for the roster the space names, and asks for it', () => {
    const cache = new RecordCache(new MemoryKeyValueStore());
    const owner = createIdentity();
    const bob = createIdentity();
    const nonce = 'nonce-of-roster';
    const spaceId = spaceIdFor(owner.publicKey, nonce);
    const code = 'abcdefghijklmnop';
    const roster = signRoster(owner, spaceId, [bob.userId]);
    const space = signRecord(owner, 'space', recordKey.space(spaceId), {
      name: 'Space',
      owner: owner.userId,
      nonce,
      admins: [],
      bans: [],
      publicInvite: inviteCommitment(spaceId, code),
      channels: [],
      authority: signSpaceAuthority(owner, spaceId, [], 1, undefined, undefined, roster.hash),
    });
    const invite = signRecord(owner, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
    });
    const join = signRecord(bob, 'member', recordKey.member(spaceId, bob.userId), {
      spaceId,
      userId: bob.userId,
      inviteCode: code,
    });
    const asked: string[][] = [];
    cache.on('wanted', (keys) => asked.push(keys));
    cache.ingestAll([space, invite], false);
    expect(cache.ingest(join, false)).toBe(false);
    expect(asked.at(-1)).toContain(recordKey.roster(spaceId));
    // It gets in when the roster arrives, not before.
    expect(cache.get(join.key)).toBeUndefined();
    expect(cache.ingest(roster.record, false)).toBe(true);
    expect(cache.get(join.key)).toBeDefined();
  });
});
