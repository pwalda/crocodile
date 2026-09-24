import type { FedPresence, PresenceEntry, Platform, ServerEvents } from '@crocodile/protocol';
import type { Coordinator } from './coordinator';

export type OwnStatus = 'online' | 'idle' | 'dnd' | 'invisible';
type FedEntry = FedPresence['entries'][number];

/** One authenticated client WebSocket (one device of one user). */
export interface ClientHandle {
  readonly connId: number;
  readonly userId: string;
  readonly deviceId: string;
  /** `<userId>.<deviceId>` */
  readonly peer: string;
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

const STATUS_RANK: Record<string, number> = {
  online: 4,
  dnd: 3,
  idle: 2,
  invisible: 1,
  offline: 0,
};

/**
 * Who is online, on which devices, and where. A user is online if any device
 * is; their shown status is the "most present" across devices. Remote users
 * are learned from mesh gossip, per server and device.
 */
export class PresenceService {
  /** userId -> deviceId -> connection */
  private localDevices = new Map<string, Map<string, ClientHandle>>();
  /** userId -> serverId -> state of that user's devices on that server */
  private remote = new Map<
    string,
    Map<string, { status: FedEntry['status']; text?: string; since: number; devices: string[] }>
  >();
  private watchers = new Map<string, Set<ClientHandle>>();

  constructor(private readonly hub: Coordinator) {}

  get localCount() {
    let n = 0;
    for (const d of this.localDevices.values()) n += d.size;
    return n;
  }

  *localClients(): Iterable<ClientHandle> {
    for (const devices of this.localDevices.values()) yield* devices.values();
  }

  localOf(userId: string): ClientHandle[] {
    return [...(this.localDevices.get(userId)?.values() ?? [])];
  }

  localPeer(peer: string): ClientHandle | undefined {
    const [userId, deviceId] = peer.split('.') as [string, string];
    return this.localDevices.get(userId)?.get(deviceId);
  }

  /** Registers a client; returns a previous connection of the same device, if any. */
  attach(client: ClientHandle): ClientHandle | undefined {
    let devices = this.localDevices.get(client.userId);
    if (!devices) this.localDevices.set(client.userId, (devices = new Map()));
    const previous = devices.get(client.deviceId);
    devices.set(client.deviceId, client);
    this.changed(client.userId, true);
    return previous;
  }

  detach(client: ClientHandle) {
    this.unwatchAll(client);
    const devices = this.localDevices.get(client.userId);
    if (devices?.get(client.deviceId) !== client) return false;
    devices.delete(client.deviceId);
    if (devices.size === 0) this.localDevices.delete(client.userId);
    this.changed(client.userId, true);
    return true;
  }

  setStatus(client: ClientHandle, status: OwnStatus, text?: string) {
    client.status = status;
    client.statusText = text;
    this.changed(client.userId, true);
  }

  private localAggregate(
    userId: string,
  ): { status: OwnStatus; text?: string; since: number } | null {
    const devices = this.localOf(userId);
    if (devices.length === 0) return null;
    const best = devices.sort(
      (a, b) => STATUS_RANK[b.status]! - STATUS_RANK[a.status]! || b.connectedAt - a.connectedAt,
    )[0]!;
    return {
      status: best.status,
      text: best.statusText,
      since: Math.min(...devices.map((d) => d.connectedAt)),
    };
  }

  publicEntry(userId: string): PresenceEntry {
    const candidates: { status: FedEntry['status']; text?: string }[] = [];
    const local = this.localAggregate(userId);
    if (local) candidates.push(local);
    for (const e of this.remote.get(userId)?.values() ?? []) candidates.push(e);
    const best = candidates.sort((a, b) => STATUS_RANK[b.status]! - STATUS_RANK[a.status]!)[0];
    if (!best || best.status === 'invisible' || best.status === 'offline')
      return { userId, status: 'offline' };
    return { userId, status: best.status, ...(best.text ? { text: best.text } : {}) };
  }

  /** Servers that currently host at least one device of the user (excluding us). */
  remoteServersOf(userId: string): string[] {
    return [...(this.remote.get(userId) ?? new Map())]
      .filter(([, e]) => e.status !== 'offline')
      .map(([s]) => s);
  }

  /** Server hosting a specific device. */
  locatePeer(peer: string): string | null {
    if (this.localPeer(peer)) return this.hub.info.id;
    const [userId, deviceId] = peer.split('.') as [string, string];
    let best: { server: string; since: number } | null = null;
    for (const [server, e] of this.remote.get(userId) ?? []) {
      if (e.devices.includes(deviceId) && (!best || e.since > best.since))
        best = { server, since: e.since };
    }
    return best?.server ?? null;
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

  private fedEntry(userId: string): FedEntry {
    const agg = this.localAggregate(userId);
    if (!agg) return { userId, status: 'offline', since: Date.now(), devices: [] };
    return {
      userId,
      status: agg.status,
      ...(agg.text ? { text: agg.text } : {}),
      since: agg.since,
      devices: this.localOf(userId).map((c) => c.deviceId),
    };
  }

  localEntries(): FedEntry[] {
    return [...this.localDevices.keys()].map((u) => this.fedEntry(u));
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
      if (e.status === 'offline' || e.devices.length === 0) entries.delete(serverId);
      else
        entries.set(serverId, {
          status: e.status,
          text: e.text,
          since: e.since,
          devices: e.devices,
        });
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
    if (local)
      this.hub.mesh.broadcast({ t: 'presence', full: false, entries: [this.fedEntry(userId)] });
    const entry = this.publicEntry(userId);
    const fingerprint = `${entry.status}|${entry.text ?? ''}`;
    if ((this.lastPublished.get(userId) ?? 'offline|') === fingerprint) return;
    if (entry.status === 'offline') this.lastPublished.delete(userId);
    else this.lastPublished.set(userId, fingerprint);
    for (const w of this.watchers.get(userId) ?? []) w.send('presence', entry);
  }
}
