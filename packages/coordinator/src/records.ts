import { canManageSpace, userIdFromKey, validateRecord } from '@crocodile/crypto';
import {
  LIMITS,
  NOTE_TTL_MS,
  RECORD_KIND_ORDER,
  recordKey,
  type RecordBodies,
  type SignedRecord,
} from '@crocodile/protocol';
import { dependenciesOf } from './placement';
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
  /** Invitations to named people not yet accepted, withdrawn or out of time. */
  privateInvitesPerSpace: number;
  /** Invite records one member (not an owner or admin) may have made in a space, withdrawn ones too. */
  invitesPerMember: number;
  /** Invitations a member (not an owner or admin) may have waiting in a space. */
  privateInvitesPerMember: number;
  /** Spaces a user is an active member of. */
  membershipsPerUser: number;
  /** Unread notes for one user. */
  notesPerUser: number;
}

/** How many times the notes quota a server will hold when copies arrive from other owners. */
const NOTE_COPIES_MAX = 2;

export const defaultRecordQuotas: RecordQuotas = {
  devicesPerUser: 100,
  spacesPerUser: 100,
  invitesPerSpace: 1000,
  privateInvitesPerSpace: 100,
  invitesPerMember: 50,
  privateInvitesPerMember: 10,
  membershipsPerUser: 500,
  notesPerUser: LIMITS.notesPerUser,
};

export type RecordListener = (
  record: SignedRecord,
  seq: number,
  origin: string | null,
  previous: SignedRecord | null,
) => void;

interface Pending {
  record: SignedRecord;
  origin: string;
  at: number;
  /** Keys of the records it waits for. */
  waitingFor: string[];
}

/**
 * Validates and stores signed records. Records arriving by replication whose
 * dependencies are not here yet (e.g. a membership before its invite) wait,
 * indexed by what they wait for, and are retried when that arrives: a write
 * retries only the records that depend on it, never the whole queue.
 */
export class RecordService {
  private listeners = new Set<RecordListener>();
  private pending = new Set<Pending>();
  /** Pending records by the key they wait for. */
  private waiting = new Map<string, Set<Pending>>();
  private pendingFrom = new Map<string, number>();
  private static readonly MAX_PENDING = 10_000;
  /** One server can't fill the queue for everyone else. */
  private static readonly MAX_PENDING_PER_ORIGIN = 2_000;
  private static readonly PENDING_MS = 10 * 60_000;
  /** Records a check may look at besides the store (fetched from their owners). */
  lookup: (key: string) => SignedRecord | undefined = (key) => this.store.get(key);

  constructor(
    readonly store: Store,
    private readonly log: Logger,
    private readonly quotas: RecordQuotas = defaultRecordQuotas,
  ) {}

  /** Unread notes held for the recipient of a note. */
  private notesHeld(note: SignedRecord): number {
    return this.store.countByTerm(`note-to:${note.key.split(':')[1]}`);
  }

  /**
   * Why a new record would exceed its author's quota, if it would. Only notes are counted when a
   * copy comes from another server: each owner takes a user's notes up to the quota on its own, so
   * copies are let in past it, but only so far (a deletion marker takes no place in the count).
   */
  private overQuota(record: SignedRecord, fresh: boolean): string | undefined {
    const q = this.quotas;
    if (!fresh && record.kind !== 'note') return undefined;
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
        const body = record.body as RecordBodies['invite'];
        const { spaceId } = body;
        const known = this.store.get(record.key) as SignedRecord<'invite'> | undefined;
        if (!known) {
          if (this.store.countByTerm(`invite-space:${spaceId}`) >= q.invitesPerSpace)
            return `at most ${q.invitesPerSpace} invites per space`;
        }
        // An invitation that was withdrawn or lapsed and is revived waits again.
        const wasWaiting = known !== undefined && this.outstanding(known.body);
        const waits = this.outstanding(body) && !wasWaiting;
        // A member invites by name, where the space allows it, and may not use up the space's room.
        const space = this.lookup(recordKey.space(spaceId)) as SignedRecord<'space'> | undefined;
        const member =
          !!space && !canManageSpace(space.body, userIdFromKey(record.author))
            ? record.author
            : null;
        if (!waits && !(member && !known)) return undefined;
        // One pass over the space's invites for all that is counted.
        const now = Date.now();
        let made = 0;
        let waiting = 0;
        let waitingOfMember = 0;
        for (const r of this.store.findByTerm(`invite-space:${spaceId}`, q.invitesPerSpace)) {
          if (r.key === record.key) continue;
          if (r.author === member) made++;
          if (!this.waitingFor(r, now)) continue;
          waiting++;
          if (r.author === member) waitingOfMember++;
        }
        if (member && !known && made >= q.invitesPerMember)
          return `at most ${q.invitesPerMember} invites per member`;
        if (!waits) return undefined;
        if (waiting >= q.privateInvitesPerSpace)
          return `at most ${q.privateInvitesPerSpace} invitations waiting per space`;
        // A member's share of that: the room is not theirs to use up.
        return member && waitingOfMember >= q.privateInvitesPerMember
          ? `at most ${q.privateInvitesPerMember} invitations waiting per member`
          : undefined;
      }
      case 'member': {
        const { userId, left } = record.body as RecordBodies['member'];
        return !left && this.store.countByTerm(`member-user:${userId}`) >= q.membershipsPerUser
          ? `at most ${q.membershipsPerUser} spaces per account`
          : undefined;
      }
      case 'note': {
        if ((record.body as RecordBodies['note']).deleted) return undefined;
        const limit = q.notesPerUser * (fresh ? 1 : NOTE_COPIES_MAX);
        return this.notesHeld(record) >= limit
          ? `at most ${limit} unread notes per account`
          : undefined;
      }
      default:
        return undefined;
    }
  }

  /** An invitation to a named person that can still be accepted (or has yet to be seen to be). */
  private outstanding(body: RecordBodies['invite'], now = Date.now()) {
    return (
      body.for !== undefined && !body.revoked && (body.expiresAt === null || body.expiresAt > now)
    );
  }

  /** Whether an invite record is an invitation to a named person still waiting to be taken up. */
  private waitingFor(r: SignedRecord, now: number) {
    const body = r.body as RecordBodies['invite'];
    if (!this.outstanding(body, now)) return false;
    // One who has joined no longer waits.
    const joined = this.store.get(recordKey.member(body.spaceId, body.for!)) as
      SignedRecord<'member'> | undefined;
    return !joined || joined.body.left === true;
  }

  onAccepted(fn: RecordListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(key: string) {
    return this.store.get(key);
  }

  put(input: unknown, opts: { fresh: boolean; origin: string | null }): PutResult {
    const key = (input as { key?: unknown })?.key;
    const result = validateRecord(input, {
      // The record's own key: only what we store counts as already having it.
      // Anything else (an author's profile, a space) may come from the lookup.
      get: (k) => (k === key ? this.store.get(k) : this.lookup(k)),
      now: Date.now(),
      fresh: opts.fresh,
    });
    const current = typeof key === 'string' ? (this.store.get(key) ?? null) : null;
    // The same record again (a retry after an answer was lost, or a copy that
    // arrived first by another path): it is stored, which is what was asked.
    if (current && current.sig === (input as { sig?: unknown })?.sig)
      return { accepted: true, current };
    if (!result.ok) {
      if (result.retryable && !opts.fresh && opts.origin)
        this.addPending(input as SignedRecord, opts.origin);
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
    // So would deleting a note that isn't here.
    if (
      opts.fresh &&
      !current &&
      record.kind === 'note' &&
      (record.body as RecordBodies['note']).deleted
    )
      return { accepted: false, current, reason: 'no such note' };
    // A new invitation counts; so does one that was withdrawn or lapsed and is brought back.
    if (grows || record.kind === 'invite') {
      const over = this.overQuota(record, opts.fresh);
      if (over) return { accepted: false, current, reason: `quota reached: ${over}` };
    }
    const seq = this.store.put(record);
    for (const fn of this.listeners) {
      try {
        fn(record, seq, opts.origin, current);
      } catch (err) {
        this.log.error('record listener failed', { err: String(err) });
      }
    }
    this.retryWaitingFor(record.key);
    return { accepted: true, current: record, seq };
  }

  /** Drops notes (and their deletion markers) older than NOTE_TTL_MS; returns how many. */
  expireNotes(now = Date.now()): number {
    let n = 0;
    for (const r of this.store.listPrefix('note:', 1_000_000)) {
      if (r.version < now - NOTE_TTL_MS) {
        this.store.delete(r.key);
        n++;
      }
    }
    return n;
  }

  private addPending(record: SignedRecord, origin: string) {
    let deps: string[];
    try {
      deps = dependenciesOf(record, userIdFromKey(record.author));
    } catch {
      return;
    }
    const missing = deps.filter((k) => !this.lookup(k));
    const entry: Pending = {
      record,
      origin,
      at: Date.now(),
      waitingFor: missing.length ? missing : deps,
    };
    this.dropExpired();
    if ((this.pendingFrom.get(origin) ?? 0) >= RecordService.MAX_PENDING_PER_ORIGIN)
      this.dropOldest((p) => p.origin === origin);
    if (this.pending.size >= RecordService.MAX_PENDING) this.dropOldest(() => true);
    this.pending.add(entry);
    this.pendingFrom.set(origin, (this.pendingFrom.get(origin) ?? 0) + 1);
    for (const k of entry.waitingFor) {
      let set = this.waiting.get(k);
      if (!set) this.waiting.set(k, (set = new Set()));
      set.add(entry);
    }
  }

  private removePending(entry: Pending) {
    if (!this.pending.delete(entry)) return;
    const n = (this.pendingFrom.get(entry.origin) ?? 1) - 1;
    if (n > 0) this.pendingFrom.set(entry.origin, n);
    else this.pendingFrom.delete(entry.origin);
    for (const k of entry.waitingFor) {
      const set = this.waiting.get(k);
      set?.delete(entry);
      if (set?.size === 0) this.waiting.delete(k);
    }
  }

  private dropOldest(match: (p: Pending) => boolean) {
    for (const p of this.pending) {
      if (match(p)) {
        this.removePending(p);
        return;
      }
    }
  }

  private dropExpired() {
    const cutoff = Date.now() - RecordService.PENDING_MS;
    // Oldest first (insertion order): stop at the first one still fresh.
    for (const p of this.pending) {
      if (p.at > cutoff) break;
      this.removePending(p);
    }
  }

  /** Records that waited for `key`, which just arrived: try them again. */
  private retryWaitingFor(key: string) {
    const set = this.waiting.get(key);
    if (!set) return;
    this.dropExpired();
    const queue = [...set]
      .filter((p) => this.pending.has(p))
      .sort((a, b) => RECORD_KIND_ORDER[a.record.kind] - RECORD_KIND_ORDER[b.record.kind]);
    for (const p of queue) this.removePending(p);
    // put() queues a record again if it still waits for something.
    for (const p of queue) this.put(p.record, { fresh: false, origin: p.origin });
  }

  /** How many replicated records wait for a dependency (tests and diagnostics). */
  get pendingCount() {
    return this.pending.size;
  }
}
