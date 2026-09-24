import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { SignedRecord } from '@crocodile/protocol';

export interface StoredRecord {
  seq: number;
  record: SignedRecord;
}

/**
 * Durable state of a coordination server: replicated signed records plus a
 * little local bookkeeping. Every write gets a local, strictly increasing seq
 * that mesh peers use as their replication cursor.
 */
export interface Store {
  readonly kind: 'sqlite' | 'memory';
  get(key: string): SignedRecord | undefined;
  /** Inserts or replaces; caller has already validated the record. */
  put(record: SignedRecord): number;
  listPrefix(prefix: string, limit: number): SignedRecord[];
  since(seq: number, limit: number): StoredRecord[];
  latestSeq(): number;
  /** Records indexed under a term (see indexTerms). */
  findByTerm(term: string, limit: number): SignedRecord[];
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  close(): void;
}

/** Secondary index terms so common queries avoid full scans. */
export function indexTerms(record: SignedRecord): string[] {
  switch (record.kind) {
    case 'profile': {
      const name = (record.body as { username: string }).username.toLowerCase();
      return [`name:${name}`];
    }
    case 'friends': {
      const body = record.body as { friends: string[] };
      return body.friends.map((f) => `friend-of:${f}`);
    }
    case 'member': {
      const body = record.body as { userId: string; left?: boolean };
      return body.left ? [] : [`member-user:${body.userId}`];
    }
    default:
      return [];
  }
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private records = new Map<string, StoredRecord>();
  private bySeq = new Map<number, string>();
  private terms = new Map<string, Set<string>>();
  private meta = new Map<string, string>();
  private seq = 0;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** With a path, state is snapshotted to a JSON file every few seconds. */
  constructor(private readonly snapshotPath?: string) {
    if (snapshotPath && existsSync(snapshotPath)) {
      const data = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
        records: StoredRecord[];
        meta: [string, string][];
      };
      for (const r of data.records.sort((a, b) => a.seq - b.seq)) this.insert(r.record, r.seq);
      this.meta = new Map(data.meta);
    }
    if (snapshotPath) {
      this.timer = setInterval(() => this.flush(), 5000);
      this.timer.unref?.();
    }
  }

  private insert(record: SignedRecord, seq: number) {
    const prev = this.records.get(record.key);
    if (prev) {
      this.bySeq.delete(prev.seq);
      for (const t of indexTerms(prev.record)) this.terms.get(t)?.delete(record.key);
    }
    this.records.set(record.key, { seq, record });
    this.bySeq.set(seq, record.key);
    for (const t of indexTerms(record)) {
      let set = this.terms.get(t);
      if (!set) this.terms.set(t, (set = new Set()));
      set.add(record.key);
    }
    this.seq = Math.max(this.seq, seq);
  }

  get(key: string) {
    return this.records.get(key)?.record;
  }

  put(record: SignedRecord) {
    const seq = ++this.seq;
    this.insert(record, seq);
    this.dirty = true;
    return seq;
  }

  listPrefix(prefix: string, limit: number) {
    const out: SignedRecord[] = [];
    for (const [key, r] of this.records) {
      if (key.startsWith(prefix)) out.push(r.record);
      if (out.length >= limit) break;
    }
    return out;
  }

  since(seq: number, limit: number) {
    const out: StoredRecord[] = [];
    for (let s = seq + 1; s <= this.seq && out.length < limit; s++) {
      const key = this.bySeq.get(s);
      if (key) out.push(this.records.get(key)!);
    }
    return out;
  }

  latestSeq() {
    return this.seq;
  }

  findByTerm(term: string, limit: number) {
    const keys = [...(this.terms.get(term) ?? [])].slice(0, limit);
    return keys.map((k) => this.records.get(k)!.record);
  }

  getMeta(key: string) {
    return this.meta.get(key);
  }

  setMeta(key: string, value: string) {
    this.meta.set(key, value);
    this.dirty = true;
  }

  flush() {
    if (!this.snapshotPath || !this.dirty) return;
    this.dirty = false;
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ records: [...this.records.values()], meta: [...this.meta] }));
    renameSync(tmp, this.snapshotPath);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }
}

type Row = Record<string, unknown>;
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid: number | bigint };
    get(...args: unknown[]): Row | undefined;
    all(...args: unknown[]): Row[];
  };
  close(): void;
}

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  private db: SqliteDb;
  private stmts;

  constructor(path: string) {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDb };
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS records (
        key TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terms (
        term TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (term, key)
      );
      CREATE INDEX IF NOT EXISTS terms_by_key ON terms(key);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.stmts = {
      get: this.db.prepare('SELECT json FROM records WHERE key = ?'),
      maxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM records'),
      upsert: this.db.prepare(
        `INSERT INTO records (key, seq, kind, version, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, version = excluded.version, json = excluded.json`,
      ),
      delTerms: this.db.prepare('DELETE FROM terms WHERE key = ?'),
      addTerm: this.db.prepare('INSERT OR IGNORE INTO terms (term, key) VALUES (?, ?)'),
      prefix: this.db.prepare('SELECT json FROM records WHERE key >= ? AND key < ? ORDER BY key LIMIT ?'),
      since: this.db.prepare('SELECT seq, json FROM records WHERE seq > ? ORDER BY seq LIMIT ?'),
      byTerm: this.db.prepare(
        'SELECT r.json FROM terms t JOIN records r ON r.key = t.key WHERE t.term = ? LIMIT ?',
      ),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ),
    };
    this.seq = Number(this.stmts.maxSeq.get()!.s);
  }

  private seq: number;

  get(key: string) {
    const row = this.stmts.get.get(key);
    return row ? (JSON.parse(row.json as string) as SignedRecord) : undefined;
  }

  put(record: SignedRecord) {
    const seq = ++this.seq;
    this.db.exec('BEGIN');
    try {
      this.stmts.upsert.run(record.key, seq, record.kind, record.version, JSON.stringify(record));
      this.stmts.delTerms.run(record.key);
      for (const t of indexTerms(record)) this.stmts.addTerm.run(t, record.key);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return seq;
  }

  listPrefix(prefix: string, limit: number) {
    // Prefixes end in ':' so bumping the last char gives an exclusive upper bound.
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return this.stmts.prefix.all(prefix, upper, limit).map((r) => JSON.parse(r.json as string) as SignedRecord);
  }

  since(seq: number, limit: number) {
    return this.stmts.since
      .all(seq, limit)
      .map((r) => ({ seq: Number(r.seq), record: JSON.parse(r.json as string) as SignedRecord }));
  }

  latestSeq() {
    return this.seq;
  }

  findByTerm(term: string, limit: number) {
    return this.stmts.byTerm.all(term, limit).map((r) => JSON.parse(r.json as string) as SignedRecord);
  }

  getMeta(key: string) {
    return this.stmts.getMeta.get(key)?.value as string | undefined;
  }

  setMeta(key: string, value: string) {
    this.stmts.setMeta.run(key, value);
  }

  close() {
    this.db.close();
  }
}

/** SQLite when the runtime ships node:sqlite, otherwise a JSON-snapshotted memory store. */
export function openStore(opts: { dataDir?: string; kind?: 'sqlite' | 'memory' }): Store {
  if (opts.kind !== 'memory') {
    try {
      return new SqliteStore(opts.dataDir ? `${opts.dataDir}/coordinator.sqlite` : ':memory:');
    } catch (err) {
      if (opts.kind === 'sqlite') throw err;
    }
  }
  return new MemoryStore(opts.dataDir ? `${opts.dataDir}/coordinator.json` : undefined);
}
