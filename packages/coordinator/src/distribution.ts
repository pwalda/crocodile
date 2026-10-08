import { userIdFromKey } from '@crocodile/crypto';
import {
  FedRequestParams,
  SignedRecordEnvelope,
  type FedRequest,
  type ProfileBody,
  type SignedRecord,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { fnv1a } from './election';
import {
  dependenciesOf,
  homeShardOf,
  shardOfKey,
  shardOfPrefix,
  shardOfTerm,
  shardsOf,
  type View,
} from './placement';
import type { PutResult } from './records';
import { RpcFailure } from './util';

export interface DistributionConfig {
  /** Records we no longer own go once the live set has been stable this long. */
  gcStableMs: number;
  /** How often we look for such records. */
  gcCheckMs: number;
  /** How long an owner keeps a watch, and how often watchers renew. */
  watchTtlMs: number;
  watchRenewMs: number;
  /** How long records fetched for a check are kept. */
  cacheMs: number;
  /** How often we compare what we hold with one other owner, and fix the difference. */
  repairMs: number;
}

export const defaultDistributionConfig: DistributionConfig = {
  gcStableMs: 10 * 60_000,
  gcCheckMs: 60_000,
  watchTtlMs: 5 * 60_000,
  watchRenewMs: 2 * 60_000,
  cacheMs: 5 * 60_000,
  repairMs: 5 * 60_000,
};

const CACHE_MAX = 20_000;
/** Watches one server may hold here, so a misbehaving one can't fill our memory. */
const WATCHES_PER_SERVER = 50_000;
/** Copies that arrived before what they depend on: fetched and tried again a few times. */
const RETRY_MS = 1500;
const RETRY_TRIES = 5;

/**
 * Where records are read from and written to (docs/MESH.md). Each record lives
 * on the owners of its shards; this server answers for shards it owns and
 * asks their owners for the rest, keeps watches for its clients on shards it
 * doesn't own, and moves records when the set of live servers changes.
 */
export class Distribution {
  /** Records fetched from other servers for checks and membership tests. */
  private cache = new Map<string, { record: SignedRecord; at: number }>();
  /** Owner side: shard -> watching server -> key prefix -> expiry. */
  private watchers = new Map<string, Map<string, Map<string, number>>>();
  private renewTimer?: ReturnType<typeof setInterval>;
  private gcTimer?: ReturnType<typeof setInterval>;
  private watchSoon?: ReturnType<typeof setTimeout>;
  private rebalancing: Promise<void> = Promise.resolve();
  private retries: { record: SignedRecord; from: string; tries: number }[] = [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private repairTimer?: ReturnType<typeof setInterval>;
  private repairing = false;

  constructor(
    private readonly hub: Coordinator,
    readonly config: DistributionConfig,
  ) {}

  private get self() {
    return this.hub.info.id;
  }

  private get view(): View {
    return this.hub.membership.view;
  }

  start() {
    this.hub.membership.on({
      settled: (before, after) => {
        this.rebalancing = this.rebalancing
          .then(() => this.rebalance(before, after))
          .catch((err) => this.hub.log.warn('moving records failed', { err: String(err) }));
        this.refreshWatchesSoon();
      },
    });
    this.renewTimer = setInterval(() => this.refreshWatches(), this.config.watchRenewMs);
    this.renewTimer.unref?.();
    this.gcTimer = setInterval(() => this.collectGarbage(), this.config.gcCheckMs);
    this.gcTimer.unref?.();
    this.repairTimer = setInterval(() => void this.repair(), this.config.repairMs);
    this.repairTimer.unref?.();
  }

  stop() {
    clearInterval(this.renewTimer);
    clearInterval(this.gcTimer);
    clearTimeout(this.watchSoon);
    clearTimeout(this.retryTimer);
    clearInterval(this.repairTimer);
  }

  ownsShard(shard: string) {
    return this.view.ownersOf(shard).includes(this.self);
  }

  private others(shard: string) {
    return this.view.ownersOf(shard).filter((id) => id !== this.self);
  }

  // -------------------------------------------------------------------------
  // Local lookups (store plus recently fetched records)
  // -------------------------------------------------------------------------

  /** A record from our store, or one fetched for a check in the last few minutes. */
  lookup(key: string): SignedRecord | undefined {
    const stored = this.hub.records.store.get(key);
    if (stored) return stored;
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.config.cacheMs) return c.record;
    if (c) this.cache.delete(key);
    return undefined;
  }

  private remember(records: SignedRecord[]) {
    const now = Date.now();
    for (const r of records) {
      const have = this.cache.get(r.key);
      if (have && have.record.version > r.version) continue;
      this.cache.set(r.key, { record: r, at: now });
    }
    if (this.cache.size > CACHE_MAX) {
      const drop = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of drop.slice(0, drop.length - CACHE_MAX / 2)) this.cache.delete(k);
    }
  }

  /** Fetch records we don't have from their owners, for the checks that need them. */
  private async fetchMissing(keys: string[]) {
    const missing = keys.filter((k) => !this.lookup(k));
    if (missing.length) await this.get(missing);
  }

  private async ensureDependencies(record: SignedRecord) {
    let authorId: string;
    try {
      authorId = userIdFromKey(record.author);
    } catch {
      return;
    }
    await this.fetchMissing(dependenciesOf(record, authorId)).catch(() => {});
    // An invite reaches the owners of its space before those of its code.
    const body = record.body as { spaceId?: string; inviteCode?: string };
    if (record.kind === 'member' && body.inviteCode && body.spaceId) {
      const key = `invite:${body.inviteCode}`;
      const owners = this.others(`space:${body.spaceId}`);
      if (!this.lookup(key) && owners.length) {
        await this.hub.mesh
          .requestAny<{ records: SignedRecord[] }>(owners, 'rec_get', { keys: [key] })
          .then(({ records }) => this.remember(records.filter((r) => r.key === key)))
          .catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * A client's new record: checked and stored by an owner of its home shard
   * (us, if we are one), which copies it to the other owners.
   */
  async putFromClient(input: unknown): Promise<PutResult> {
    const env = SignedRecordEnvelope.safeParse(input);
    let home: string | undefined;
    if (env.success) {
      try {
        home = homeShardOf(input as SignedRecord);
      } catch {
        // A malformed body: let the local check say why.
      }
    }
    if (!home || this.ownsShard(home)) return this.putLocal(input, { fresh: true, origin: null });
    try {
      const res = await this.hub.mesh.requestAny<PutResult>(this.others(home), 'rec_put', {
        record: input,
      });
      if (res.accepted) this.remember([input as SignedRecord]);
      return res;
    } catch {
      throw new RpcFailure('unavailable', 'the servers holding this record are unreachable');
    }
  }

  async putLocal(
    input: unknown,
    opts: { fresh: boolean; origin: string | null },
  ): Promise<PutResult> {
    if (SignedRecordEnvelope.safeParse(input).success)
      await this.ensureDependencies(input as SignedRecord);
    return this.hub.records.put(input, opts);
  }

  /** Records another server copied to us, as an owner. */
  async onReplicated(items: { seq: number; record: SignedRecord }[], from: string) {
    for (const item of items) {
      if (!SignedRecordEnvelope.safeParse(item.record).success) continue;
      const have = this.hub.records.store.get(item.record.key);
      if (have && have.version >= item.record.version) continue;
      await this.ensureDependencies(item.record);
      const res = this.hub.records.put(item.record, { fresh: false, origin: from });
      if (!res.accepted && /^unknown /.test(res.reason ?? ''))
        this.retryLater({ record: item.record, from, tries: 0 });
    }
  }

  private retryLater(item: { record: SignedRecord; from: string; tries: number }) {
    if (item.tries >= RETRY_TRIES || this.retries.length > 10_000) return;
    this.retries.push(item);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const due = this.retries.splice(0);
      void (async () => {
        for (const r of due) {
          const have = this.hub.records.store.get(r.record.key);
          if (have && have.version >= r.record.version) continue;
          await this.ensureDependencies(r.record);
          const res = this.hub.records.put(r.record, { fresh: false, origin: r.from });
          if (!res.accepted && /^unknown /.test(res.reason ?? ''))
            this.retryLater({ ...r, tries: r.tries + 1 });
        }
      })();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Records by key, from our store for shards we own and from their owners otherwise. */
  async get(keys: string[]): Promise<SignedRecord[]> {
    const out = new Map<string, SignedRecord>();
    const remote = new Map<string, string[]>();
    for (const key of new Set(keys)) {
      const shard = shardOfKey(key);
      if (!shard || this.ownsShard(shard)) {
        const r = this.hub.records.store.get(key);
        if (r) out.set(key, r);
      } else {
        const list = remote.get(shard) ?? [];
        list.push(key);
        remote.set(shard, list);
      }
    }
    await Promise.all(
      [...remote].map(async ([shard, group]) => {
        let found: SignedRecord[] = [];
        try {
          found = (
            await this.hub.mesh.requestAny<{ records: SignedRecord[] }>(
              this.others(shard),
              'rec_get',
              { keys: group },
            )
          ).records.filter((r) => group.includes(r.key));
          this.remember(found);
        } catch {
          // Owners unreachable: what we still hold is better than nothing.
        }
        for (const r of found) out.set(r.key, r);
        // A record we wrote a moment ago may not have reached the owner we asked.
        for (const key of group) {
          const mine = this.lookup(key);
          if (mine && (out.get(key)?.version ?? 0) < mine.version) out.set(key, mine);
        }
      }),
    );
    return [...out.values()];
  }

  async list(prefix: string, limit: number): Promise<SignedRecord[]> {
    const shard = shardOfPrefix(prefix);
    const store = this.hub.records.store;
    if (!shard || this.ownsShard(shard)) return store.listPrefix(prefix, limit);
    try {
      const { records } = await this.hub.mesh.requestAny<{ records: SignedRecord[] }>(
        this.others(shard),
        'rec_list',
        { prefix, limit },
      );
      return records.filter((r) => r.key.startsWith(prefix)).slice(0, limit);
    } catch {
      return store.listPrefix(prefix, limit);
    }
  }

  async findByTerm(term: string, limit: number): Promise<SignedRecord[]> {
    const shard = shardOfTerm(term);
    const store = this.hub.records.store;
    if (!shard || this.ownsShard(shard)) return store.findByTerm(term, limit);
    try {
      const { records } = await this.hub.mesh.requestAny<{ records: SignedRecord[] }>(
        this.others(shard),
        'rec_term',
        { term, limit },
      );
      return records.slice(0, limit);
    } catch {
      return store.findByTerm(term, limit);
    }
  }

  // -------------------------------------------------------------------------
  // Requests from other servers
  // -------------------------------------------------------------------------

  async handleRequest(from: string, m: FedRequest['m'], p: unknown): Promise<unknown> {
    const schema = FedRequestParams[m];
    if (!schema) throw new RpcFailure('not_found', `unknown request ${m}`);
    const parsed = schema.safeParse(p);
    if (!parsed.success) throw new RpcFailure('bad_request', 'invalid parameters');
    const store = this.hub.records.store;
    switch (m) {
      case 'rec_put': {
        const { record } = parsed.data as { record: unknown };
        const r = await this.putLocal(record, { fresh: true, origin: null });
        return {
          accepted: r.accepted,
          current: r.current,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      case 'rec_get': {
        const { keys } = parsed.data as { keys: string[] };
        return { records: keys.map((k) => store.get(k)).filter(Boolean) };
      }
      case 'rec_list': {
        const { prefix, limit } = parsed.data as { prefix: string; limit?: number };
        return { records: store.listPrefix(prefix, limit ?? 1000) };
      }
      case 'rec_term': {
        const { term, limit } = parsed.data as { term: string; limit?: number };
        return { records: store.findByTerm(term, limit ?? 1000) };
      }
      case 'digest': {
        const { buckets } = parsed.data as { buckets: number[] };
        const mine = this.digest(from);
        return { differ: mine.map((v, i) => i).filter((i) => mine[i] !== buckets[i]) };
      }
      case 'digest_keys': {
        const { buckets } = parsed.data as { buckets: number[] };
        const wanted = new Set(buckets);
        return {
          keys: this.shared(from)
            .filter((r) => wanted.has(bucketOf(r.key)))
            .slice(0, 20_000)
            .map((r) => ({ key: r.key, version: r.version })),
        };
      }
      case 'watch': {
        const { items, ttlMs } = parsed.data as {
          items: { shard: string; prefix: string }[];
          ttlMs: number;
        };
        const until = Date.now() + ttlMs;
        let held = 0;
        for (const byServer of this.watchers.values()) held += byServer.get(from)?.size ?? 0;
        for (const { shard, prefix } of items) {
          if (held++ >= WATCHES_PER_SERVER)
            throw new RpcFailure('rate_limited', 'too many watches');
          let byServer = this.watchers.get(shard);
          if (!byServer) this.watchers.set(shard, (byServer = new Map()));
          let prefixes = byServer.get(from);
          if (!prefixes) byServer.set(from, (prefixes = new Map()));
          prefixes.set(prefix, until);
        }
        return {};
      }
    }
  }

  // -------------------------------------------------------------------------
  // Watches: changes to shards we don't own, for our clients
  // -------------------------------------------------------------------------

  /** Owner side: tell the servers watching this record's shards. */
  onAccepted(record: SignedRecord) {
    const now = Date.now();
    const told = new Set<string>([this.self]);
    for (const shard of shardsOf(record)) {
      const byServer = this.watchers.get(shard);
      if (!byServer) continue;
      for (const [server, prefixes] of byServer) {
        for (const [prefix, until] of prefixes) {
          if (until < now) prefixes.delete(prefix);
          else if (!told.has(server) && record.key.startsWith(prefix)) {
            told.add(server);
            this.hub.mesh.sendTo(server, { t: 'rec_push', record });
          }
        }
        if (prefixes.size === 0) byServer.delete(server);
      }
      if (byServer.size === 0) this.watchers.delete(shard);
    }
  }

  /** Watcher side: a record our clients may want, from its owner. */
  async onPush(input: SignedRecord) {
    if (!SignedRecordEnvelope.safeParse(input).success) return;
    const record = input as SignedRecord;
    this.remember([record]);
    this.hub.pushRecordToClients(record);
    if (record.kind === 'profile' && (record.body as ProfileBody).deleted)
      this.hub.signOutDeleted(
        record.key.slice('profile:'.length),
        record as SignedRecord<'profile'>,
      );
  }

  refreshWatchesSoon() {
    if (this.watchSoon) return;
    this.watchSoon = setTimeout(() => {
      this.watchSoon = undefined;
      this.refreshWatches();
    }, 100);
    this.watchSoon.unref?.();
  }

  /** Ask owners to watch the shards our clients follow and we don't own. */
  refreshWatches() {
    const wanted = new Map<string, Set<string>>();
    const add = (shard: string | undefined, prefix: string) => {
      if (!shard || this.ownsShard(shard)) return;
      let set = wanted.get(shard);
      if (!set) wanted.set(shard, (set = new Set()));
      set.add(prefix);
    };
    for (const client of this.hub.presence.localClients()) {
      // Everything about the user: their memberships, notes and own records.
      add(`user:${client.userId}`, '');
      for (const prefix of client.subscriptions) add(shardOfPrefix(prefix), prefix);
    }
    const byOwner = new Map<string, { shard: string; prefix: string }[]>();
    for (const [shard, prefixes] of wanted) {
      for (const owner of this.others(shard)) {
        const items = byOwner.get(owner) ?? [];
        for (const prefix of prefixes) items.push({ shard, prefix });
        byOwner.set(owner, items);
      }
    }
    for (const [owner, items] of byOwner) {
      for (let i = 0; i < items.length; i += 5000) {
        this.hub.mesh
          .request(owner, 'watch', {
            items: items.slice(i, i + 5000),
            ttlMs: this.config.watchTtlMs,
          })
          .catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Moving records when servers come and go
  // -------------------------------------------------------------------------

  /**
   * Send every record to the servers that have just become its owners. Only
   * the first live old owner sends, so each record goes once.
   */
  private async rebalance(before: View, after: View) {
    const store = this.hub.records.store;
    const live = new Set(after.ring.ids);
    const outgoing = new Map<string, SignedRecord[]>();
    let moved = 0;
    for (let cursor = 0; ;) {
      const batch = store.since(cursor, 1000);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
      for (const { record } of batch) {
        const was = before.placement(record);
        const now = after.placement(record);
        const newcomers = now.filter((id) => id !== this.self && !was.includes(id));
        if (newcomers.length === 0) continue;
        const lead = was.find((id) => live.has(id)) ?? this.self;
        if (lead !== this.self) continue;
        for (const id of newcomers) {
          const list = outgoing.get(id) ?? [];
          list.push(record);
          outgoing.set(id, list);
          moved++;
        }
      }
      // Let other work in.
      await new Promise((r) => setImmediate(r));
    }
    for (const [id, records] of outgoing) await this.hub.mesh.handOver(id, records);
    if (moved)
      this.hub.log.info('records handed to new owners', { records: moved, servers: outgoing.size });
  }

  // -------------------------------------------------------------------------
  // Repair: copies that went missing despite everything above
  // -------------------------------------------------------------------------

  /** Records we hold that both we and `peer` own (by the settled view). */
  private shared(peer: string): SignedRecord[] {
    const settled = this.hub.membership.settled;
    const out: SignedRecord[] = [];
    const store = this.hub.records.store;
    for (let cursor = 0; ;) {
      const batch = store.since(cursor, 1000);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
      for (const { record } of batch) {
        const owners = settled.placement(record);
        if (owners.includes(peer) && owners.includes(this.self)) out.push(record);
      }
    }
    return out;
  }

  /** Order-independent sums of (key, version) over the shared records, in 256 buckets. */
  private digest(peer: string): number[] {
    const sums = new Array<number>(256).fill(0);
    for (const r of this.shared(peer)) {
      const b = bucketOf(r.key);
      sums[b] = (sums[b]! + fnv1a(`${r.key}@${r.version}`)) % 2 ** 32;
    }
    return sums;
  }

  /**
   * Compare what we hold with one other live owner and exchange the
   * difference: what they lack or hold older we send, what we lack we fetch.
   */
  async repair(peer?: string) {
    const m = this.hub.membership;
    if (this.repairing || !m.settled.equals(m.view)) return;
    const others = m.liveIds().filter((id) => id !== this.self);
    const target = peer ?? others[Math.floor(Math.random() * others.length)];
    if (!target) return;
    this.repairing = true;
    try {
      const { differ } = await this.hub.mesh.request<{ differ: number[] }>(target, 'digest', {
        buckets: this.digest(target),
      });
      if (!differ.length) return;
      const { keys } = await this.hub.mesh.request<{ keys: { key: string; version: number }[] }>(
        target,
        'digest_keys',
        { buckets: differ },
      );
      const theirs = new Map(keys.map((k) => [k.key, k.version]));
      const wanted = new Set(differ);
      const mine = this.shared(target).filter((r) => wanted.has(bucketOf(r.key)));
      const send = mine.filter((r) => (theirs.get(r.key) ?? 0) < r.version);
      const store = this.hub.records.store;
      const fetch = keys
        .filter((k) => (store.get(k.key)?.version ?? 0) < k.version)
        .map((k) => k.key);
      if (send.length) await this.hub.mesh.handOver(target, send);
      for (let i = 0; i < fetch.length; i += 500) {
        const { records } = await this.hub.mesh.request<{ records: SignedRecord[] }>(
          target,
          'rec_get',
          { keys: fetch.slice(i, i + 500) },
        );
        await this.onReplicated(
          records.map((record) => ({ seq: 0, record })),
          target,
        );
      }
      if (send.length || fetch.length)
        this.hub.log.info('repaired copies', {
          peer: target,
          sent: send.length,
          fetched: fetch.length,
        });
    } catch {
      // Unreachable or busy: another round will try someone else.
    } finally {
      this.repairing = false;
    }
  }

  /** Delete records we don't own, once the live set has been stable for a while. */
  collectGarbage(now = Date.now()) {
    const m = this.hub.membership;
    const settled = m.settled;
    if (!settled.equals(m.view) || now - m.stableSince < this.config.gcStableMs) return 0;
    if (settled.ownsAll || settled.full.includes(this.self)) return 0;
    const store = this.hub.records.store;
    const drop: string[] = [];
    for (let cursor = 0; ;) {
      const batch = store.since(cursor, 1000);
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.seq;
      for (const { record } of batch) if (!settled.owns(this.self, record)) drop.push(record.key);
    }
    for (const key of drop) store.delete(key);
    if (drop.length) this.hub.log.info('dropped records owned elsewhere', { records: drop.length });
    return drop.length;
  }
}

function bucketOf(key: string) {
  return fnv1a(key) & 255;
}
