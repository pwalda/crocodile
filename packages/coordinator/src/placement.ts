import type { RecordBodies, SignedRecord } from '@crocodile/protocol';
import { fnv1a } from './election';

/**
 * Where records live (see docs/MESH.md). Each record belongs to one or more
 * shards; each shard is owned by the first `replicas` servers clockwise from
 * its point on a consistent-hash ring of the live servers, plus every live
 * server that keeps a full copy.
 */

/** Points per server on the ring: enough to spread shards evenly. */
const VNODES = 16;

export class HashRing {
  private readonly points: { pos: number; id: string }[];
  readonly ids: readonly string[];

  constructor(ids: Iterable<string>) {
    this.ids = [...new Set(ids)].sort();
    this.points = this.ids
      .flatMap((id) => Array.from({ length: VNODES }, (_, i) => ({ pos: fnv1a(`${id}#${i}`), id })))
      .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
  }

  /** The first `k` distinct servers clockwise from the shard's point. */
  owners(shard: string, k: number): string[] {
    const n = Math.min(k, this.ids.length);
    if (n === 0) return [];
    if (n === this.ids.length) return [...this.ids];
    const pos = fnv1a(shard);
    // First point at or after pos.
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid]!.pos < pos) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = 0; out.length < n; i++) {
      const id = this.points[(lo + i) % this.points.length]!.id;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }
}

/** A snapshot of who owns what. */
export class View {
  readonly ring: HashRing;
  private readonly cache = new Map<string, string[]>();

  constructor(
    live: Iterable<string>,
    /** Live servers that keep a full copy. */
    readonly full: readonly string[],
    readonly replicas: number,
  ) {
    this.ring = new HashRing(live);
  }

  get size() {
    return this.ring.ids.length;
  }

  /** Every live server owns everything (a small network, or only full copies). */
  get ownsAll() {
    return this.size <= this.replicas;
  }

  ownersOf(shard: string): string[] {
    let owners = this.cache.get(shard);
    if (!owners) {
      owners = [...this.ring.owners(shard, this.replicas)];
      for (const id of this.full) if (!owners.includes(id)) owners.push(id);
      if (this.cache.size > 50_000) this.cache.clear();
      this.cache.set(shard, owners);
    }
    return owners;
  }

  /** Owners of any of the record's shards. */
  placement(record: SignedRecord): string[] {
    const out: string[] = [];
    for (const shard of shardsOf(record))
      for (const id of this.ownersOf(shard)) if (!out.includes(id)) out.push(id);
    return out;
  }

  owns(serverId: string, record: SignedRecord) {
    return this.placement(record).includes(serverId);
  }

  equals(other: View) {
    return (
      this.replicas === other.replicas &&
      this.ring.ids.join() === other.ring.ids.join() &&
      [...this.full].sort().join() === [...other.full].sort().join()
    );
  }
}

const user = (id: string) => `user:${id}`;

/** The shards a record is stored under. */
export function shardsOf(record: SignedRecord): string[] {
  const parts = record.key.split(':');
  switch (record.kind) {
    case 'profile': {
      const name = (record.body as RecordBodies['profile']).username.toLowerCase();
      return [user(parts[1]!), `name:${name}`];
    }
    case 'device':
    case 'friends':
    case 'note':
      return [user(parts[1]!)];
    case 'space':
      return [`space:${parts[1]}`, user((record.body as RecordBodies['space']).owner)];
    case 'invite':
      return [`invite:${parts[1]}`, `space:${(record.body as RecordBodies['invite']).spaceId}`];
    case 'member':
      return [`space:${parts[1]}`, user(parts[2]!)];
  }
}

/**
 * The shard whose owners check a new record: it holds everything the
 * record's quota counts, and the author's profile where possible.
 */
export function homeShardOf(record: SignedRecord): string {
  const shards = shardsOf(record);
  switch (record.kind) {
    case 'space':
    case 'member':
      return shards[1]!;
    case 'invite':
      return shards[1]!;
    default:
      return shards[0]!;
  }
}

/** The shard holding the record stored under a key, if the key says. */
export function shardOfKey(key: string): string | undefined {
  const [kind, a, b] = key.split(':');
  if (!a) return undefined;
  switch (kind) {
    case 'profile':
    case 'friends':
      return b === undefined ? user(a) : undefined;
    case 'device':
    case 'note':
      return user(a);
    case 'space':
      return b === undefined ? `space:${a}` : undefined;
    case 'member':
      return `space:${a}`;
    case 'invite':
      return b === undefined ? `invite:${a}` : undefined;
    default:
      return undefined;
  }
}

/** The shard holding every record whose key starts with `prefix`, if there is one. */
export function shardOfPrefix(prefix: string): string | undefined {
  // device:<user>:…, note:<user>:…, member:<space>:…
  const m = /^(device|note|member):([a-z2-7]+):/.exec(prefix);
  if (m) return shardOfKey(`${m[1]}:${m[2]}:x`);
  // A whole key of the single-record kinds.
  if (/^(profile|friends|space|invite):[a-z2-7]+$/.test(prefix)) return shardOfKey(prefix);
  return undefined;
}

/** The shard holding every record indexed under a term (see indexTerms). */
export function shardOfTerm(term: string): string | undefined {
  const i = term.indexOf(':');
  const kind = term.slice(0, i);
  const value = term.slice(i + 1);
  switch (kind) {
    case 'member-user':
    case 'member-any':
    case 'owner':
    case 'note-to':
      return user(value);
    case 'name':
      return `name:${value}`;
    case 'invite-space':
      return `space:${value}`;
    default:
      // friend-of: lists in the old readable form; answered from what this server holds.
      return undefined;
  }
}

/** Records a record's checks look at, besides the record itself. */
export function dependenciesOf(record: SignedRecord, authorId: string): string[] {
  const deps = record.kind === 'note' ? [] : [`profile:${authorId}`];
  const body = record.body as { spaceId?: string; inviteCode?: string };
  if (record.kind === 'invite') deps.push(`space:${body.spaceId}`);
  if (record.kind === 'member') {
    deps.push(`space:${body.spaceId}`);
    if (body.inviteCode) deps.push(`invite:${body.inviteCode}`);
  }
  if (record.kind === 'note') deps.push(`profile:${record.key.split(':')[1]}`);
  return deps;
}
