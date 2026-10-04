import { validateRecord } from '@crocodile/crypto';
import {
  RECORD_KIND_ORDER,
  recordKey,
  type RecordBodies,
  type SignedRecord,
} from '@crocodile/protocol';
import type { Store } from './store';
import type { Logger } from './util';

export interface PutResult {
  accepted: boolean;
  current: SignedRecord | null;
  reason?: string;
  seq?: number;
}

/**
 * Limits on how many records one user can make this server store. They apply
 * to new keys written by this server's own clients (updates and replicated
 * records are not counted), and are generous for real use: they only stop a
 * single account from filling the server's disk.
 */
export interface RecordQuotas {
  /** Device records per user, revoked ones included. */
  devicesPerUser: number;
  /** Spaces a user owns, deleted ones included. */
  spacesPerUser: number;
  /** Invites per space (the app reuses a valid invite rather than making new ones). */
  invitesPerSpace: number;
  /** Spaces a user is an active member of. */
  membershipsPerUser: number;
}

export const defaultRecordQuotas: RecordQuotas = {
  devicesPerUser: 100,
  spacesPerUser: 100,
  invitesPerSpace: 1000,
  membershipsPerUser: 500,
};

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
    private readonly quotas: RecordQuotas = defaultRecordQuotas,
  ) {}

  /** Why a new record would exceed its author's quota, if it would. */
  private overQuota(record: SignedRecord): string | undefined {
    const q = this.quotas;
    switch (record.kind) {
      case 'device': {
        const { userId } = record.body as RecordBodies['device'];
        const n = this.store.listPrefix(recordKey.devicePrefix(userId), q.devicesPerUser).length;
        return n >= q.devicesPerUser
          ? `at most ${q.devicesPerUser} devices per account`
          : undefined;
      }
      case 'space': {
        const { owner } = record.body as RecordBodies['space'];
        return this.store.countByTerm(`owner:${owner}`) >= q.spacesPerUser
          ? `at most ${q.spacesPerUser} spaces per account`
          : undefined;
      }
      case 'invite': {
        const { spaceId } = record.body as RecordBodies['invite'];
        return this.store.countByTerm(`invite-space:${spaceId}`) >= q.invitesPerSpace
          ? `at most ${q.invitesPerSpace} invites per space`
          : undefined;
      }
      case 'member': {
        const { userId, left } = record.body as RecordBodies['member'];
        return !left && this.store.countByTerm(`member-user:${userId}`) >= q.membershipsPerUser
          ? `at most ${q.membershipsPerUser} spaces per account`
          : undefined;
      }
      default:
        return undefined;
    }
  }

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
    // Updates don't grow storage; rejoining a space you left does count.
    const grows =
      !current ||
      (record.kind === 'member' &&
        (current.body as RecordBodies['member']).left &&
        !(record.body as RecordBodies['member']).left);
    // A leave record for a membership that doesn't exist would be free storage.
    if (
      opts.fresh &&
      !current &&
      record.kind === 'member' &&
      (record.body as RecordBodies['member']).left
    )
      return { accepted: false, current, reason: 'not a member of this space' };
    if (opts.fresh && grows) {
      const over = this.overQuota(record);
      if (over) return { accepted: false, current, reason: `quota reached: ${over}` };
    }
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
