import { describe, expect, it } from 'vitest';
import { createIdentity, signRecord, spaceIdFor, type Identity } from '@crocodile/crypto';
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
});
