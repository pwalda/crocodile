import { describe, expect, it } from 'vitest';
import { createIdentity, signRecord, spaceIdFor, type Identity } from '@crocodile/crypto';
import { recordKey, type SignedRecord } from '@crocodile/protocol';
import { MemoryStore } from '../src';
import { RecordService } from '../src/records';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function profile(id: Identity) {
  return signRecord(id, 'profile', recordKey.profile(id.userId), {
    username: `u${id.userId.slice(0, 6)}`,
    encKey: id.encPublicKey,
  });
}

function space(owner: Identity, nonce: string) {
  const spaceId = spaceIdFor(owner.publicKey, nonce);
  const record = signRecord(owner, 'space', `space:${spaceId}`, {
    name: 'Space',
    owner: owner.userId,
    nonce,
    admins: [],
    bans: [],
    channels: [],
  });
  return { spaceId, record };
}

function member(id: Identity, spaceId: string, inviteCode?: string) {
  return signRecord(id, 'member', `member:${spaceId}:${id.userId}`, {
    spaceId,
    userId: id.userId,
    ...(inviteCode ? { inviteCode } : {}),
  } as never);
}

describe('records waiting for a dependency', () => {
  it('a write retries only the records that wait for it', () => {
    const records = new RecordService(new MemoryStore(), quiet);
    // A linked server sends memberships of spaces that don't exist.
    for (let i = 0; i < 300; i++) {
      const id = createIdentity();
      records.put(member(id, spaceIdFor(id.publicKey, `nonce${i}x`)), {
        fresh: false,
        origin: 'srv-a',
      });
    }
    expect(records.pendingCount).toBe(300);

    let lookups = 0;
    const lookup = records.lookup;
    records.lookup = (k) => (lookups++, lookup(k));
    const carol = createIdentity();
    expect(records.put(profile(carol), { fresh: true, origin: null }).accepted).toBe(true);
    // Validating carol's profile, not 300 memberships again.
    expect(lookups).toBeLessThan(10);
    expect(records.pendingCount).toBe(300);
  });

  it('a waiting record is stored once everything it waits for arrives', () => {
    const records = new RecordService(new MemoryStore(), quiet);
    const owner = createIdentity();
    const bob = createIdentity();
    const { spaceId, record: spaceRecord } = space(owner, 'nonce001');
    const invite = signRecord(owner, 'invite', 'invite:codeabcd', {
      code: 'codeabcd',
      spaceId,
      expiresAt: null,
      revoked: false,
    } as never);
    const membership = member(bob, spaceId, 'codeabcd');
    const origin = { fresh: false, origin: 'srv-a' };

    expect(records.put(membership, origin).accepted).toBe(false);
    expect(records.put(spaceRecord, origin).accepted).toBe(true);
    // Still waiting, now for the invite.
    expect(records.get(membership.key)).toBeUndefined();
    expect(records.pendingCount).toBe(1);
    expect(records.put(invite, origin).accepted).toBe(true);
    expect(records.get(membership.key)?.sig).toBe(membership.sig);
    expect(records.pendingCount).toBe(0);
  });

  it('one server cannot fill the queue for the others', () => {
    const records = new RecordService(new MemoryStore(), quiet);
    const owner = createIdentity();
    const { spaceId, record: spaceRecord } = space(owner, 'nonce001');
    const fromB = member(owner, spaceId);
    records.put(fromB, { fresh: false, origin: 'srv-b' });
    const flood: SignedRecord[] = [];
    for (let i = 0; i < 2100; i++) {
      const id = createIdentity();
      flood.push(member(id, spaceIdFor(id.publicKey, `nonce${i}x`)));
    }
    for (const r of flood) records.put(r, { fresh: false, origin: 'srv-a' });
    expect(records.pendingCount).toBe(2001);
    // srv-b's record still waits, and gets in when the space arrives.
    records.put(spaceRecord, { fresh: false, origin: 'srv-b' });
    expect(records.get(fromB.key)?.sig).toBe(fromB.sig);
  }, 30_000);
});
