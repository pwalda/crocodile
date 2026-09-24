import { validateRecord } from '@crocodile/crypto';
import { RECORD_KIND_ORDER, type SignedRecord } from '@crocodile/protocol';
import type { Store } from './store';
import type { Logger } from './util';

export interface PutResult {
  accepted: boolean;
  current: SignedRecord | null;
  reason?: string;
  seq?: number;
}

export type RecordListener = (record: SignedRecord, seq: number, origin: string | null) => void;

/**
 * Validates and stores signed records. Records arriving by replication whose
 * dependencies are not here yet (e.g. a membership before its invite) wait in
 * a bounded pending queue and are retried after each accepted write.
 */
export class RecordService {
  private listeners = new Set<RecordListener>();
  private pending: { record: SignedRecord; origin: string; at: number }[] = [];
  private static readonly MAX_PENDING = 10_000;

  constructor(
    readonly store: Store,
    private readonly log: Logger,
  ) {}

  onAccepted(fn: RecordListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(key: string) {
    return this.store.get(key);
  }

  put(input: unknown, opts: { fresh: boolean; origin: string | null }): PutResult {
    const result = validateRecord(input, {
      get: (k) => this.store.get(k),
      now: Date.now(),
      fresh: opts.fresh,
    });
    const key = (input as { key?: unknown })?.key;
    const current = typeof key === 'string' ? (this.store.get(key) ?? null) : null;
    if (!result.ok) {
      if (result.retryable && !opts.fresh && opts.origin) {
        if (this.pending.length >= RecordService.MAX_PENDING) this.pending.shift();
        this.pending.push({ record: input as SignedRecord, origin: opts.origin, at: Date.now() });
      }
      return { accepted: false, current, reason: result.reason };
    }
    const record = input as SignedRecord;
    const seq = this.store.put(record);
    for (const fn of this.listeners) {
      try {
        fn(record, seq, opts.origin);
      } catch (err) {
        this.log.error('record listener failed', { err: String(err) });
      }
    }
    if (this.pending.length) this.retryPending();
    return { accepted: true, current: record, seq };
  }

  private retrying = false;
  private retryPending() {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const cutoff = Date.now() - 10 * 60_000;
      const queue = this.pending
        .filter((p) => p.at > cutoff)
        .sort((a, b) => RECORD_KIND_ORDER[a.record.kind] - RECORD_KIND_ORDER[b.record.kind]);
      this.pending = [];
      for (const p of queue) {
        // put() re-queues the record itself if its dependency is still missing.
        this.put(p.record, { fresh: false, origin: p.origin });
      }
    } finally {
      this.retrying = false;
    }
  }
}
