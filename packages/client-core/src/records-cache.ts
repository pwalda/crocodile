import { validateRecord } from '@crocodile/crypto';
import { RECORD_KIND_ORDER, type SignedRecord } from '@crocodile/protocol';
import { Emitter } from './emitter';
import type { KeyValueStore } from './platform';

const KV_KEY = 'records-cache';

/**
 * Client-side copy of the signed records we care about. Every record is
 * re-verified here: the client does not trust coordination servers.
 * Persisted so the app can show spaces and friends while offline.
 */
export class RecordCache extends Emitter<{ changed: SignedRecord; wanted: string[] }> {
  private map = new Map<string, SignedRecord>();
  private pending: SignedRecord[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly kv: KeyValueStore) {
    super();
  }

  async load() {
    const saved = await this.kv.get<SignedRecord[]>(KV_KEY);
    if (saved) this.ingestAll(saved, false);
  }

  get(key: string) {
    return this.map.get(key);
  }

  list(prefix: string): SignedRecord[] {
    const out: SignedRecord[] = [];
    for (const [k, r] of this.map) if (k.startsWith(prefix)) out.push(r);
    return out;
  }

  /**
   * Drops a record we stored optimistically before the server refused it,
   * unless a newer version has arrived since.
   */
  forget(key: string, version: number) {
    if (this.map.get(key)?.version !== version) return;
    this.map.delete(key);
    this.scheduleSave();
  }

  ingestAll(records: SignedRecord[], persist = true) {
    const sorted = [...records].sort(
      (a, b) => RECORD_KIND_ORDER[a.kind] - RECORD_KIND_ORDER[b.kind],
    );
    for (const r of sorted) this.ingest(r, persist);
  }

  /** Returns true if the record was new and valid. */
  ingest(record: SignedRecord, persist = true): boolean {
    const existing = this.map.get(record.key);
    if (existing && existing.version >= record.version) return false;
    const res = validateRecord(record, {
      get: (k) => this.map.get(k),
      now: Date.now(),
      fresh: false,
    });
    if (!res.ok) {
      if (res.retryable) {
        this.pending.push(record);
        if (this.pending.length > 2000) this.pending.shift();
        const wanted = dependenciesOf(record).filter((k) => !this.map.has(k));
        if (wanted.length) this.emit('wanted', wanted);
      }
      return false;
    }
    this.map.set(record.key, record);
    if (persist) this.scheduleSave();
    this.emit('changed', record);
    if (this.pending.length) {
      const retry = this.pending.splice(0);
      for (const r of retry) this.ingest(r, persist);
    }
    return true;
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.kv.set(KV_KEY, [...this.map.values()]), 1000);
  }
}

/** Records a record's validation depends on. */
function dependenciesOf(record: SignedRecord): string[] {
  const body = record.body as { spaceId?: string; inviteCode?: string };
  if (record.kind === 'invite') return [`space:${body.spaceId}`];
  if (record.kind === 'member') {
    return [`space:${body.spaceId}`, ...(body.inviteCode ? [`invite:${body.inviteCode}`] : [])];
  }
  return [];
}
