import type { FedPresence, PresenceEntry, Platform, ServerEvents } from '@crocodile/protocol';
import type { Coordinator } from './coordinator';

export type OwnStatus = 'online' | 'idle' | 'dnd' | 'invisible';
type FedEntry = FedPresence['entries'][number];

/** One authenticated client WebSocket, as seen by the services. */
export interface ClientHandle {
  readonly connId: number;
  readonly userId: string;
  readonly platform: Platform;
  readonly connectedAt: number;
  status: OwnStatus;
  statusText?: string;
  subscriptions: Set<string>;
  presenceWatch: Set<string>;
  voiceWatch: Set<string>;
  send<E extends keyof ServerEvents>(ev: E, d: ServerEvents[E]): void;
  close(code: number, reason: string): void;
}

/**
 * Who is online and where. Local users are authoritative here; users on other
 * servers are learned from mesh presence gossip. Also answers "which server
 * do I route an event for user X to".
 */
export class PresenceService {
  readonly local = new Map<string, ClientHandle>();
  private remote = new Map<string, Map<string, { status: FedEntry['status']; text?: string; since: number }>>();
  private watchers = new Map<string, Set<ClientHandle>>();

  constructor(private readonly hub: Coordinator) {}

  /** Registers a client; returns a previous connection of the same user, if any. */
  attach(client: ClientHandle): ClientHandle | undefined {
    const previous = this.local.get(client.userId);
    this.local.set(client.userId, client);
    this.changed(client.userId, true);
    return previous;
  }

  detach(client: ClientHandle) {
    this.unwatchAll(client);
    if (this.local.get(client.userId) !== client) return false;
    this.local.delete(client.userId);
    this.changed(client.userId, true);
    return true;
  }

  setStatus(client: ClientHandle, status: OwnStatus, text?: string) {
    client.status = status;
    client.statusText = text;
    this.changed(client.userId, true);
  }

  publicEntry(userId: string): PresenceEntry {
    const local = this.local.get(userId);
    if (local) {
      return local.status === 'invisible'
        ? { userId, status: 'offline' }
        : { userId, status: local.status, ...(local.statusText ? { text: local.statusText } : {}) };
    }
    const best = this.newestRemote(userId);
    if (!best || best.status === 'invisible' || best.status === 'offline') return { userId, status: 'offline' };
    return { userId, status: best.status, ...(best.text ? { text: best.text } : {}) };
  }

  /** Server that currently hosts the user's connection (self id for local users). */
  locate(userId: string): string | null {
    if (this.local.has(userId)) return this.hub.info.id;
    return this.newestRemote(userId)?.serverId ?? null;
  }

  private newestRemote(userId: string) {
    const entries = this.remote.get(userId);
    if (!entries) return null;
    let best: { serverId: string; status: FedEntry['status']; text?: string; since: number } | null = null;
    for (const [serverId, e] of entries) {
      if (e.status === 'offline') continue;
      if (!best || e.since > best.since) best = { serverId, ...e };
    }
    return best;
  }

  watch(client: ClientHandle, userIds: string[]): PresenceEntry[] {
    for (const id of userIds) {
      client.presenceWatch.add(id);
      let set = this.watchers.get(id);
      if (!set) this.watchers.set(id, (set = new Set()));
      set.add(client);
    }
    return userIds.map((id) => this.publicEntry(id));
  }

  unwatchAll(client: ClientHandle) {
    for (const id of client.presenceWatch) {
      const set = this.watchers.get(id);
      set?.delete(client);
      if (set && set.size === 0) this.watchers.delete(id);
    }
    client.presenceWatch.clear();
  }

  localEntries(): FedEntry[] {
    return [...this.local.values()].map((c) => ({
      userId: c.userId,
      status: c.status,
      ...(c.statusText ? { text: c.statusText } : {}),
      since: c.connectedAt,
    }));
  }

  applyRemote(serverId: string, frame: FedPresence) {
    const touched = new Set<string>();
    if (frame.full) {
      for (const [userId, entries] of this.remote) {
        if (entries.delete(serverId)) touched.add(userId);
        if (entries.size === 0) this.remote.delete(userId);
      }
    }
    for (const e of frame.entries) {
      let entries = this.remote.get(e.userId);
      if (!entries) this.remote.set(e.userId, (entries = new Map()));
      if (e.status === 'offline') entries.delete(serverId);
      else entries.set(serverId, { status: e.status, text: e.text, since: e.since });
      if (entries.size === 0) this.remote.delete(e.userId);
      touched.add(e.userId);
    }
    for (const userId of touched) this.changed(userId, false);
  }

  dropServer(serverId: string) {
    this.applyRemote(serverId, { t: 'presence', full: true, entries: [] });
  }

  private lastPublished = new Map<string, string>();

  private changed(userId: string, local: boolean) {
    if (local) {
      const c = this.local.get(userId);
      const entry: FedEntry = c
        ? { userId, status: c.status, ...(c.statusText ? { text: c.statusText } : {}), since: c.connectedAt }
        : { userId, status: 'offline', since: Date.now() };
      this.hub.mesh.broadcast({ t: 'presence', full: false, entries: [entry] });
    }
    const entry = this.publicEntry(userId);
    const fingerprint = `${entry.status}|${entry.text ?? ''}`;
    if ((this.lastPublished.get(userId) ?? 'offline|') === fingerprint) return;
    if (entry.status === 'offline') this.lastPublished.delete(userId);
    else this.lastPublished.set(userId, fingerprint);
    for (const w of this.watchers.get(userId) ?? []) w.send('presence', entry);
  }
}
