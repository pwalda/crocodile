import type { ChatMessage } from '@crocodile/protocol';
import type { KeyValueStore } from './platform';

/** Unacknowledged messages are kept (and re-offered) for this long. */
export const OUTBOX_MAX_AGE_MS = 30 * 24 * 3600_000;
const MAX_ENTRIES = 5000;
const KEY = 'outbox';

export interface OutboxEntry {
  message: ChatMessage;
  sessionId: string;
  /** Deposited in a server mailbox (DMs, opt-in). */
  mailed?: boolean;
}

/**
 * Messages this device wrote that no other member has confirmed yet. Whenever
 * a peer who should have them shows up, the queue is offered to it; the
 * peer's acknowledgement removes them. This makes delivery independent of
 * clocks and of who happened to be online when a message was written.
 */
export class Outbox {
  private entries = new Map<string, OutboxEntry>();
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly kv: KeyValueStore) {}

  async load() {
    const saved = (await this.kv.get<OutboxEntry[]>(KEY)) ?? [];
    const cutoff = Date.now() - OUTBOX_MAX_AGE_MS;
    this.entries = new Map(
      saved.filter((e) => e.message.ts > cutoff).map((e) => [e.message.id, e]),
    );
  }

  add(message: ChatMessage, sessionId: string) {
    this.entries.set(message.id, { message, sessionId });
    while (this.entries.size > MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.save();
  }

  has(id: string) {
    return this.entries.has(id);
  }

  get(id: string) {
    return this.entries.get(id);
  }

  /** Pending messages of a session, oldest first. */
  forSession(sessionId: string): ChatMessage[] {
    return [...this.entries.values()]
      .filter((e) => e.sessionId === sessionId)
      .map((e) => e.message)
      .sort((a, b) => a.ts - b.ts);
  }

  /** Removes acknowledged ids; returns the ones that were pending. */
  ack(ids: string[]): string[] {
    const removed = ids.filter((id) => this.entries.delete(id));
    if (removed.length) this.save();
    return removed;
  }

  /** DM entries not yet in a mailbox that have waited at least `minAgeMs`. */
  unmailed(minAgeMs: number, now = Date.now()): OutboxEntry[] {
    return [...this.entries.values()].filter(
      (e) => !e.mailed && e.sessionId.startsWith('dm:') && now - e.message.ts >= minAgeMs,
    );
  }

  markMailed(ids: string[]) {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) e.mailed = true;
    }
    this.save();
  }

  get size() {
    return this.entries.size;
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.kv.set(KEY, [...this.entries.values()]).catch(() => {});
    }, 200);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    await this.kv.set(KEY, [...this.entries.values()]);
  }
}
