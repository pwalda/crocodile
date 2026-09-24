import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, signRecord } from '@crocodile/crypto';
import { recordKey } from '@crocodile/protocol';
import { MemoryStore, SqliteStore, type Store } from '../src';
import { elect, rendezvousOwner } from '../src';

const stores: [string, () => Store][] = [
  ['sqlite', () => new SqliteStore(':memory:')],
  ['memory', () => new MemoryStore()],
];

describe.each(stores)('%s store', (_name, make) => {
  it('stores, replaces, indexes and pages by seq', () => {
    const store = make();
    const alice = createIdentity();
    const bob = createIdentity();
    const p1 = signRecord(alice, 'profile', recordKey.profile(alice.userId), {
      username: 'Alice',
      encKey: alice.encPublicKey,
    });
    const p2 = signRecord(bob, 'profile', recordKey.profile(bob.userId), {
      username: 'bob',
      encKey: bob.encPublicKey,
    });
    expect(store.put(p1)).toBe(1);
    expect(store.put(p2)).toBe(2);
    expect(store.findByTerm('name:alice', 10).map((r) => r.key)).toEqual([p1.key]);
    const renamed = signRecord(
      alice,
      'profile',
      p1.key,
      { username: 'Ally', encKey: alice.encPublicKey },
      p1.version + 1,
    );
    expect(store.put(renamed)).toBe(3);
    expect(store.findByTerm('name:alice', 10)).toEqual([]);
    expect(store.findByTerm('name:ally', 10)).toHaveLength(1);
    expect(store.since(1, 10).map((r) => r.seq)).toEqual([2, 3]);
    expect(store.listPrefix('profile:', 10)).toHaveLength(2);
    store.setMeta('cursor:x', '42');
    expect(store.getMeta('cursor:x')).toBe('42');
    store.close();
  });
});

it('sqlite state survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'croc-store-'));
  const a = new SqliteStore(join(dir, 'db.sqlite'));
  const id = createIdentity();
  a.put(
    signRecord(id, 'profile', recordKey.profile(id.userId), {
      username: 'x',
      encKey: id.encPublicKey,
    }),
  );
  a.close();
  const b = new SqliteStore(join(dir, 'db.sqlite'));
  expect(b.get(recordKey.profile(id.userId))).toBeDefined();
  expect(b.latestSeq()).toBe(1);
  b.close();
});

describe('election', () => {
  const member = (peer: string, nat: 'open' | 'cone' | 'symmetric', extra = {}) => ({
    peer,
    userId: peer,
    joinedAt: 0,
    caps: { canHost: true, platform: 'desktop' as const, nat, ...extra },
  });

  it('prefers reachable, well-provisioned desktops and never elects web/mobile', () => {
    const r = elect({
      members: [
        member('a', 'symmetric'),
        member('b', 'open'),
        {
          ...member('c', 'open'),
          caps: { canHost: false, platform: 'web' as const, nat: 'open' as const },
        },
      ],
      host: null,
      backup: null,
      penalties: new Map(),
      now: 1000,
    });
    expect(r).toEqual({ host: 'b', backup: 'a' });
  });

  it('keeps the current host and skips penalised members', () => {
    const members = [
      member('a', 'cone'),
      member('b', 'open'),
      member('c', 'cone', { onBattery: true }),
    ];
    expect(elect({ members, host: 'a', backup: 'b', penalties: new Map(), now: 0 }).host).toBe('a');
    const failover = elect({
      members,
      host: 'a',
      backup: 'b',
      penalties: new Map([['a', 60_000]]),
      now: 0,
    });
    expect(failover).toEqual({ host: 'b', backup: 'c' });
  });

  it('rendezvous ownership is stable and moves minimally', () => {
    const servers = ['s1', 's2', 's3', 's4'];
    const sessions = Array.from({ length: 400 }, (_, i) => `space:session${i}`);
    const before = sessions.map((s) => rendezvousOwner(s, servers));
    const after = sessions.map((s) =>
      rendezvousOwner(
        s,
        servers.filter((x) => x !== 's2'),
      ),
    );
    sessions.forEach((_, i) => {
      if (before[i] !== 's2') expect(after[i]).toBe(before[i]);
    });
    const counts = new Map<string, number>();
    for (const o of before) counts.set(o, (counts.get(o) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeGreaterThan(60);
  });
});
