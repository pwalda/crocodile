import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, signRecord, spaceIdFor } from '@crocodile/crypto';
import { recordKey } from '@crocodile/protocol';
import { MemoryStore, SqliteStore, type Store } from '../src';
import { INDEX_VERSION } from '../src/store';
import { elect, hostScore, rendezvousOwner } from '../src';
import { fnv1a } from '../src/election';

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

  it('lists a prefix in key order, from after a key', () => {
    const store = make();
    const alice = createIdentity();
    const keys = ['b', 'a', 'd', 'c'].map((x) => recordKey.note(alice.userId, x.repeat(26)));
    for (const key of keys) {
      const author = createIdentity();
      store.put(signRecord(author, 'profile', key, { username: 'x', encKey: author.encPublicKey }));
    }
    store.put(
      signRecord(alice, 'profile', recordKey.profile(alice.userId), {
        username: 'alice',
        encKey: alice.encPublicKey,
      }),
    );
    const prefix = `note:${alice.userId}:`;
    const sorted = [...keys].sort();
    const list = (limit: number, after?: string) =>
      store.listPrefix(prefix, limit, after).map((r) => r.key);
    expect(list(10)).toEqual(sorted);
    expect(list(2)).toEqual(sorted.slice(0, 2));
    expect(list(10, sorted[1])).toEqual(sorted.slice(2));
    expect(list(1, sorted[1])).toEqual([sorted[2]]);
    expect(list(10, sorted[3])).toEqual([]);
    // A key before the prefix or past it leaves the range alone.
    expect(list(10, 'a')).toEqual(sorted);
    expect(list(10, 'z')).toEqual([]);
    store.close();
  });

  it('counts by term and deletes records and mail outright', () => {
    const store = make();
    const alice = createIdentity();
    const space = (nonce: string) =>
      signRecord(alice, 'space', recordKey.space(spaceIdFor(alice.publicKey, nonce)), {
        name: 'Swamp',
        owner: alice.userId,
        nonce,
        admins: [],
        bans: [],
        channels: [],
      });
    const [s1, s2] = [space('nonce-one'), space('nonce-two')];
    store.put(s1);
    store.put(s2);
    expect(store.countByTerm(`owner:${alice.userId}`)).toBe(2);
    store.delete(s1.key);
    expect(store.get(s1.key)).toBeUndefined();
    expect(store.countByTerm(`owner:${alice.userId}`)).toBe(1);
    expect(store.listPrefix('space:', 10).map((r) => r.key)).toEqual([s2.key]);
    expect(store.since(0, 10).map((r) => r.record.key)).toEqual([s2.key]);

    const mail = (id: string, toUser: string, from: string) =>
      store.mailPut({
        id,
        to: `${toUser}.dev`,
        toUser,
        from,
        box: '{}',
        createdAt: 1,
        expiresAt: Date.now() + 1e6,
      });
    mail('m1', alice.userId, 'bob');
    mail('m2', 'bob', alice.userId);
    mail('m3', 'bob', 'carol');
    expect(store.mailDeleteUser(alice.userId)).toBe(2);
    expect(store.mailCount({})).toBe(1);
    store.close();
  });
});

it('sqlite rebuilds its index when the index format changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'croc-store-'));
  const path = join(dir, 'db.sqlite');
  const id = createIdentity();
  const a = new SqliteStore(path);
  a.put(
    signRecord(id, 'space', recordKey.space(spaceIdFor(id.publicKey, 'nonce-one')), {
      name: 'Swamp',
      owner: id.userId,
      nonce: 'nonce-one',
      admins: [],
      bans: [],
      channels: [],
    }),
  );
  a.close();
  // A database written before the owner index existed.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec("DELETE FROM terms; UPDATE meta SET value = '1' WHERE key = 'index-version'");
  raw.close();
  const b = new SqliteStore(path);
  expect(b.countByTerm(`owner:${id.userId}`)).toBe(1);
  expect(b.getMeta('index-version')).toBe(String(INDEX_VERSION));
  b.close();
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
      sessionId: 's1',
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
    expect(
      elect({ sessionId: 's1', members, host: 'a', backup: 'b', penalties: new Map(), now: 0 })
        .host,
    ).toBe('a');
    const failover = elect({
      sessionId: 's1',
      members,
      host: 'a',
      backup: 'b',
      penalties: new Map([['a', 60_000]]),
      now: 0,
    });
    expect(failover).toEqual({ host: 'b', backup: 'c' });
  });

  it('a host behind a symmetric NAT hands over to a member others can reach', () => {
    // The caller was elected alone; the person they call is on an open network.
    const members = [member('caller', 'symmetric'), member('callee', 'open')];
    const r = elect({
      sessionId: 's1',
      members,
      host: 'caller',
      backup: null,
      penalties: new Map(),
      now: 0,
    });
    expect(r).toEqual({ host: 'callee', backup: 'caller' });
    // ...and keeps it: no flapping back.
    expect(
      elect({
        sessionId: 's1',
        members,
        host: 'callee',
        backup: 'caller',
        penalties: new Map(),
        now: 0,
      }).host,
    ).toBe('callee');
    // A member whose network check couldn't finish is still a better bet.
    const untested = [
      member('caller', 'symmetric'),
      {
        ...member('callee', 'open'),
        caps: { canHost: true, platform: 'desktop' as const, nat: 'unknown' as const },
      },
    ];
    expect(
      elect({
        sessionId: 's1',
        members: untested,
        host: 'caller',
        backup: null,
        penalties: new Map(),
        now: 0,
      }).host,
    ).toBe('callee');
    // Two symmetric NATs: nobody better, the current host stays.
    const both = [member('caller', 'symmetric'), member('callee', 'symmetric')];
    expect(
      elect({
        sessionId: 's1',
        members: both,
        host: 'caller',
        backup: null,
        penalties: new Map(),
        now: 0,
      }).host,
    ).toBe('caller');
    // A cone or open host stays even when a slightly better member joins.
    const fine = [member('a', 'cone'), member('b', 'open')];
    expect(
      elect({
        sessionId: 's1',
        members: fine,
        host: 'a',
        backup: null,
        penalties: new Map(),
        now: 0,
      }).host,
    ).toBe('a');
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

  it('gains nothing from claiming more than a good connection has', () => {
    const honest = member('honest', 'open', { uplinkKbps: 2000, cpuCores: 4, rttMs: 40 });
    const liar = member('liar', 'open', { uplinkKbps: 10_000_000, cpuCores: 1024, rttMs: 0 });
    expect(hostScore(liar, 0)).toBe(hostScore(honest, 0));
    // A poor connection still counts for less.
    expect(hostScore(member('slow', 'open', { uplinkKbps: 100 }), 0)).toBeLessThan(
      hostScore(honest, 0),
    );
  });

  it('breaks ties by a hash of the session and the device, not by the name of the device', () => {
    const members = [member('aaaa', 'cone'), member('bbbb', 'cone')];
    const pick = (sessionId: string) =>
      elect({ sessionId, members, host: null, backup: null, penalties: new Map(), now: 0 }).host;
    // The same everywhere, and not always the name that sorts first.
    const picked = new Set<string | null>();
    for (let i = 0; i < 40; i++) {
      const sid = `session-${i}`;
      expect(pick(sid)).toBe(pick(sid));
      picked.add(pick(sid));
    }
    expect(picked).toEqual(new Set(['aaaa', 'bbbb']));
    const wins = (sid: string, a: string, b: string) => fnv1a(`${sid}|${a}`) > fnv1a(`${sid}|${b}`);
    const sid = Array.from({ length: 200 }, (_, i) => `x${i}`).find((x) =>
      wins(x, 'bbbb', 'aaaa'),
    )!;
    expect(pick(sid)).toBe('bbbb');
  });

  it('counts a person once, however many devices they have, and picks another person as backup', () => {
    const device = (user: string, n: number, nat: 'open' | 'cone') => ({
      ...member(`${user}.d${n}`, nat),
      userId: user,
    });
    const members = [
      ...[1, 2, 3, 4, 5].map((n) => device('liar', n, 'open')),
      device('honest', 1, 'cone'),
    ];
    const r = elect({
      sessionId: 's1',
      members,
      host: null,
      backup: null,
      penalties: new Map(),
      now: 0,
    });
    expect(r.host).toMatch(/^liar\./);
    // Not another device of the host's person.
    expect(r.backup).toBe('honest.d1');
  });

  it("does not keep the host's own other device as backup because the others only slightly beat it", () => {
    const user = (u: string, n: number, nat: 'open' | 'cone', extra = {}) => ({
      ...member(`${u}.d${n}`, nat, extra),
      userId: u,
    });
    // a2 was the backup; b1 beats it by less than the margin that moves a backup.
    const members = [user('a', 1, 'open'), user('a', 2, 'cone'), user('b', 1, 'cone')];
    const r = elect({
      sessionId: 's1',
      members,
      host: 'a.d1',
      backup: 'a.d2',
      penalties: new Map(),
      now: 0,
    });
    expect(r.host).toBe('a.d1');
    expect(r.backup).toBe('b.d1');
  });

  it('finds a reachable device of a person whose best device is behind a symmetric NAT', () => {
    const user = (u: string, n: number, nat: 'open' | 'cone' | 'symmetric', extra = {}) => ({
      ...member(`${u}.d${n}`, nat, extra),
      userId: u,
    });
    const members = [
      user('host', 1, 'symmetric'),
      // b's best device scores higher but cannot be reached; the other can.
      user('b', 1, 'symmetric', { uplinkKbps: 100_000 }),
      user('b', 2, 'cone', { onBattery: true }),
    ];
    const r = elect({
      sessionId: 's1',
      members,
      host: 'host.d1',
      backup: null,
      penalties: new Map(),
      now: 0,
    });
    expect(r.host).toBe('b.d2');
  });

  it("puts a person's reachable device up as backup when their best one is behind a symmetric NAT", () => {
    const user = (u: string, n: number, nat: 'open' | 'cone' | 'symmetric', extra = {}) => ({
      ...member(`${u}.d${n}`, nat, extra),
      userId: u,
    });
    const members = [
      user('host', 1, 'open', { uplinkKbps: 100_000 }),
      user('b', 1, 'symmetric', { uplinkKbps: 100_000 }),
      user('b', 2, 'cone', { onBattery: true }),
    ];
    const r = elect({
      sessionId: 's1',
      members,
      host: 'host.d1',
      backup: null,
      penalties: new Map(),
      now: 0,
    });
    expect(r.backup).toBe('b.d2');
  });

  it('with everyone penalised, keeps one candidate a person, and drops a backup who left', () => {
    const user = (u: string, n: number, extra = {}) => ({
      ...member(`${u}.d${n}`, 'open', extra),
      userId: u,
    });
    const members = [
      user('a', 1, { onBattery: true }),
      user('a', 2),
      user('b', 1, { onBattery: true }),
    ];
    const penalties = new Map(members.map((m) => [m.peer, 1000]));
    const r = elect({ sessionId: 's1', members, host: null, backup: 'gone.d1', penalties, now: 0 });
    // Nobody else to choose: the best device of the best person; the backup is the other person.
    expect(r.host).toBe('a.d2');
    expect(r.backup).toBeNull();
    const free = elect({
      sessionId: 's1',
      members,
      host: 'a.d2',
      backup: 'gone.d1',
      penalties: new Map(),
      now: 0,
    });
    expect(free.backup).toBe('b.d1');
  });
});
