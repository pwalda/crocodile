import { WebSocket } from 'ws';
import { keyMatchesUserId, randomId, sign, verifyPayload } from '@crocodile/crypto';
import { LIMITS, ServerInfo, SIG_DOMAIN, type FedFrame, type SignedRecord } from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { sendJson, toWsUrl } from './util';

interface Link {
  ws: WebSocket;
  initiator: boolean;
  url?: string;
  challenge: string;
  peer?: ServerInfo;
  authed: boolean;
  replaced: boolean;
  syncing: boolean;
  syncDone: boolean;
  sentUpTo: number;
  alive: boolean;
}

const SYNC_BATCH = 500;
const PING_INTERVAL_MS = 20_000;

/**
 * Coordination-server mesh. Links are mutually authenticated with server
 * identity keys; after authentication each side streams the records the other
 * has not seen (per-peer seq cursor) and then pushes new writes live. Presence,
 * voice occupancy and session operations ride the same links.
 */
export class Mesh {
  private links = new Map<string, Link>();
  private pendingLinks = new Set<Link>();
  private known = new Map<string, ServerInfo>();
  private dialing = new Map<string, { timer?: ReturnType<typeof setTimeout>; attempts: number }>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly hub: Coordinator) {}

  start(staticPeers: string[]) {
    for (const url of staticPeers) this.ensureDial(url);
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  peerIds() {
    return [...this.links.keys()];
  }

  peers(): ServerInfo[] {
    return [...this.links.values()].map((l) => l.peer!);
  }

  knownServers(): ServerInfo[] {
    return [...this.known.values()];
  }

  /** Learn about servers (from the directory or gossip) and connect to them. */
  addKnown(servers: ServerInfo[]) {
    for (const s of servers) {
      const parsed = ServerInfo.safeParse(s);
      if (!parsed.success || s.id === this.hub.info.id || !keyMatchesUserId(s.key, s.id)) continue;
      this.known.set(s.id, s);
      if (!this.links.has(s.id)) this.ensureDial(s.url);
    }
  }

  sendTo(serverId: string, frame: FedFrame): boolean {
    const link = this.links.get(serverId);
    return link ? sendJson(link.ws, frame) : false;
  }

  broadcast(frame: FedFrame, except?: string) {
    const text = JSON.stringify(frame);
    for (const [id, link] of this.links) {
      if (id !== except && link.ws.readyState === link.ws.OPEN) link.ws.send(text);
    }
  }

  // -------------------------------------------------------------------------
  // Link lifecycle
  // -------------------------------------------------------------------------

  private ensureDial(url: string) {
    if (this.closed || url === this.hub.info.url) return;
    for (const l of [...this.links.values(), ...this.pendingLinks]) {
      if (l.url === url || l.peer?.url === url) return;
    }
    const d = this.dialing.get(url);
    if (d?.timer) return;
    this.dial(url);
  }

  private dial(url: string) {
    const state = this.dialing.get(url) ?? { attempts: 0 };
    state.timer = undefined;
    this.dialing.set(url, state);
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(url, '/v1/federation'), { maxPayload: LIMITS.wsMessageMaxBytes * 8, handshakeTimeout: 10_000 });
    } catch {
      this.scheduleRedial(url);
      return;
    }
    ws.on('error', () => {});
    const link = this.setupLink(ws, true, url);
    ws.once('open', () => this.sendHello(link));
  }

  private scheduleRedial(url: string) {
    if (this.closed) return;
    const state = this.dialing.get(url) ?? { attempts: 0 };
    state.attempts += 1;
    const isKnown = [...this.known.values()].some((s) => s.url === url) || this.hub.config.meshPeers.includes(url);
    if (!isKnown && state.attempts > 5) {
      this.dialing.delete(url);
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(state.attempts, 6)) * (0.75 + Math.random() * 0.5);
    state.timer = setTimeout(() => this.dial(url), delay);
    state.timer.unref?.();
    this.dialing.set(url, state);
  }

  accept(ws: WebSocket) {
    ws.on('error', () => {});
    const link = this.setupLink(ws, false);
    this.sendHello(link);
  }

  private sendHello(link: Link) {
    sendJson(link.ws, { t: 'fed_hello', server: this.hub.info, challenge: link.challenge });
  }

  private setupLink(ws: WebSocket, initiator: boolean, url?: string): Link {
    const link: Link = {
      ws,
      initiator,
      url,
      challenge: randomId(16),
      authed: false,
      replaced: false,
      syncing: false,
      syncDone: false,
      sentUpTo: 0,
      alive: true,
    };
    this.pendingLinks.add(link);
    const authTimer = setTimeout(() => {
      if (!link.authed) ws.terminate();
    }, 15_000);
    authTimer.unref?.();

    ws.on('pong', () => (link.alive = true));
    ws.on('message', (raw) => {
      let frame: FedFrame;
      try {
        frame = JSON.parse(raw.toString()) as FedFrame;
      } catch {
        ws.close(1003, 'bad json');
        return;
      }
      try {
        this.onFrame(link, frame);
      } catch (err) {
        this.hub.log.warn('federation frame failed', { t: frame.t, err: String(err) });
      }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.pendingLinks.delete(link);
      const peerId = link.peer?.id;
      if (peerId && this.links.get(peerId) === link) {
        this.links.delete(peerId);
        this.hub.log.info('mesh link down', { peer: peerId });
        this.hub.onServerDown(peerId);
      }
      const redialUrl = link.initiator ? url : link.peer && this.known.has(link.peer.id) ? link.peer.url : undefined;
      if (redialUrl && !link.replaced && !this.closed) this.scheduleRedial(redialUrl);
    });
    return link;
  }

  private onFrame(link: Link, frame: FedFrame) {
    if (frame.t === 'fed_hello') {
      const parsed = ServerInfo.safeParse(frame.server);
      if (!parsed.success || !keyMatchesUserId(frame.server.key, frame.server.id) || frame.server.id === this.hub.info.id) {
        link.ws.close(1008, 'invalid server identity');
        return;
      }
      link.peer = parsed.data;
      const sig = sign(this.hub.identity, SIG_DOMAIN.federation, {
        challenge: frame.challenge,
        from: this.hub.info.id,
        to: link.peer.id,
      });
      sendJson(link.ws, { t: 'fed_auth', sig, cursor: this.cursor(link.peer.id) });
      return;
    }
    if (frame.t === 'fed_auth') {
      if (!link.peer) return;
      const ok = verifyPayload(
        link.peer.key,
        SIG_DOMAIN.federation,
        { challenge: link.challenge, from: link.peer.id, to: this.hub.info.id },
        frame.sig,
      );
      if (!ok) {
        link.ws.close(1008, 'bad federation signature');
        return;
      }
      this.onAuthed(link, frame.cursor);
      return;
    }
    if (!link.authed || !link.peer) return;
    const peerId = link.peer.id;
    switch (frame.t) {
      case 'records':
        for (const item of frame.items) this.hub.records.put(item.record, { fresh: false, origin: peerId });
        this.setCursor(peerId, frame.upTo);
        return;
      case 'presence':
        this.hub.presence.applyRemote(peerId, frame);
        return;
      case 'route':
        this.hub.deliverLocal(frame.to, frame.ev as never, frame.d as never);
        return;
      case 'session_op':
        this.hub.sessions.handleRemoteOp(peerId, frame);
        return;
      case 'session_op_res':
        this.hub.sessions.handleRemoteResult(frame.opId, frame.ok, frame.err);
        return;
      case 'servers':
        this.addKnown(frame.servers);
        return;
      case 'voice':
        this.hub.sessions.applyRemoteVoice(peerId, frame);
        return;
      case 'ping':
        sendJson(link.ws, { t: 'pong' });
        return;
    }
  }

  private onAuthed(link: Link, cursor: number) {
    const peer = link.peer!;
    link.authed = true;
    this.pendingLinks.delete(link);
    const existing = this.links.get(peer.id);
    if (existing) {
      // Both sides dialled each other: keep the link dialled by the lower id.
      const keeperInitiator = this.hub.info.id < peer.id ? this.hub.info.id : peer.id;
      const initiatorOf = (l: Link) => (l.initiator ? this.hub.info.id : peer.id);
      if (initiatorOf(link) !== keeperInitiator) {
        link.replaced = true;
        link.ws.close(1000, 'duplicate link');
        return;
      }
      existing.replaced = true;
      this.links.delete(peer.id);
      existing.ws.close(1000, 'duplicate link');
    }
    this.links.set(peer.id, link);
    this.known.set(peer.id, peer);
    this.dialing.delete(peer.url);
    if (link.url) this.dialing.delete(link.url);
    this.hub.log.info('mesh link up', { peer: peer.id, name: peer.name, url: peer.url });

    sendJson(link.ws, { t: 'servers', servers: [this.hub.info, ...this.knownServers()] });
    sendJson(link.ws, { t: 'presence', full: true, entries: this.hub.presence.localEntries() });
    for (const v of this.hub.sessions.ownedVoiceFrames()) sendJson(link.ws, v);
    link.sentUpTo = Math.max(0, Math.min(cursor, this.hub.records.store.latestSeq()));
    void this.pump(link);
    this.hub.onServerUp(peer.id);
  }

  /** Streams the backlog to a freshly authenticated peer, respecting backpressure. */
  private async pump(link: Link) {
    if (link.syncing) return;
    link.syncing = true;
    const store = this.hub.records.store;
    try {
      while (link.ws.readyState === link.ws.OPEN && link.sentUpTo < store.latestSeq()) {
        const batch = store.since(link.sentUpTo, SYNC_BATCH);
        if (batch.length === 0) {
          link.sentUpTo = store.latestSeq();
          break;
        }
        const upTo = batch[batch.length - 1]!.seq;
        sendJson(link.ws, { t: 'records', items: batch, upTo });
        link.sentUpTo = upTo;
        while (link.ws.readyState === link.ws.OPEN && link.ws.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      link.syncDone = true;
    } finally {
      link.syncing = false;
    }
  }

  /** Live replication of an accepted write. */
  onRecord(record: SignedRecord, seq: number, origin: string | null) {
    for (const [id, link] of this.links) {
      if (!link.syncDone || seq <= link.sentUpTo) continue;
      if (id !== origin) sendJson(link.ws, { t: 'records', items: [{ seq, record }], upTo: seq });
      link.sentUpTo = seq;
    }
  }

  private cursor(peerId: string): number {
    return Number(this.hub.records.store.getMeta(`cursor:${peerId}`) ?? 0);
  }

  private setCursor(peerId: string, seq: number) {
    if (seq > this.cursor(peerId)) this.hub.records.store.setMeta(`cursor:${peerId}`, String(seq));
  }

  private heartbeat() {
    for (const link of this.links.values()) {
      if (!link.alive) {
        link.ws.terminate();
        continue;
      }
      link.alive = false;
      try {
        link.ws.ping();
      } catch {
        /* closed */
      }
    }
  }

  close() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const d of this.dialing.values()) if (d.timer) clearTimeout(d.timer);
    for (const link of [...this.links.values(), ...this.pendingLinks]) {
      link.replaced = true;
      link.ws.terminate();
    }
  }
}
