import { WebSocket } from 'ws';
import {
  acceptChannel,
  answerChannel,
  createChannelKeys,
  keyMatchesUserId,
  randomId,
  SecureChannel,
  sign,
  verifyPayload,
  type ChannelKeys,
} from '@crocodile/crypto';
import {
  concatBytes,
  LIMITS,
  ServerInfo,
  SIG_DOMAIN,
  type FedFrame,
  type SignedRecord,
} from '@crocodile/protocol';
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
  /** Our fresh key-exchange offer for this link. */
  channelKeys: ChannelKeys;
  peerOffer?: { x25519: string; mlkem: string };
  /** Secret from answering the peer's offer. */
  answeredSecret?: Uint8Array;
  channel?: SecureChannel;
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
    return link ? this.send(link, frame) : false;
  }

  broadcast(frame: FedFrame, except?: string) {
    for (const [id, link] of this.links) {
      if (id !== except && link.ws.readyState === link.ws.OPEN) this.send(link, frame);
    }
  }

  // -------------------------------------------------------------------------
  // Link lifecycle
  // -------------------------------------------------------------------------

  private send(link: Link, frame: FedFrame): boolean {
    if (!link.channel) return false;
    return sendJson(link.ws, link.channel.seal(frame));
  }

  private linkQueries = new Map<
    string,
    {
      pending: number;
      resolve: (v: { peer: string; key: string; encKey: string } | undefined) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Ask every peer server whether it holds a device-link code. */
  queryLink(code: string): Promise<{ peer: string; key: string; encKey: string } | undefined> {
    const peers = [...this.links.values()];
    if (peers.length === 0) return Promise.resolve(undefined);
    const qid = randomId(8);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.linkQueries.delete(qid);
        resolve(undefined);
      }, 4000);
      this.linkQueries.set(qid, { pending: peers.length, resolve, timer });
      for (const l of peers) this.send(l, { t: 'link_query', qid, code });
    });
  }

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
      ws = new WebSocket(toWsUrl(url, '/v1/federation'), {
        maxPayload: LIMITS.wsMessageMaxBytes * 8,
        handshakeTimeout: 10_000,
      });
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
    const isKnown =
      [...this.known.values()].some((s) => s.url === url) ||
      this.hub.config.meshPeers.includes(url);
    if (!isKnown && state.attempts > 5) {
      this.dialing.delete(url);
      return;
    }
    const delay =
      Math.min(60_000, 1000 * 2 ** Math.min(state.attempts, 6)) * (0.75 + Math.random() * 0.5);
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
    sendJson(link.ws, {
      t: 'fed_hello',
      server: this.hub.info,
      challenge: link.challenge,
      channel: link.channelKeys.offer,
    });
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
      channelKeys: createChannelKeys(),
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
      if (link.channel) {
        // After the handshake every frame is encrypted.
        const inner = frame.t === 'x' ? link.channel.open(frame) : undefined;
        if (inner === undefined) {
          ws.close(1008, 'bad frame');
          return;
        }
        frame = inner as FedFrame;
      } else if (frame.t !== 'fed_hello' && frame.t !== 'fed_auth') {
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
      const redialUrl = link.initiator
        ? url
        : link.peer && this.known.has(link.peer.id)
          ? link.peer.url
          : undefined;
      if (redialUrl && !link.replaced && !this.closed) this.scheduleRedial(redialUrl);
    });
    return link;
  }

  private onFrame(link: Link, frame: FedFrame) {
    if (frame.t === 'fed_hello') {
      const parsed = ServerInfo.safeParse(frame.server);
      if (
        !parsed.success ||
        !keyMatchesUserId(frame.server.key, frame.server.id) ||
        frame.server.id === this.hub.info.id
      ) {
        link.ws.close(1008, 'invalid server identity');
        return;
      }
      link.peer = parsed.data;
      link.peerOffer = frame.channel;
      let answer: { epk: string; kem: string };
      try {
        const res = answerChannel(frame.channel);
        answer = res.answer;
        link.answeredSecret = res.secret;
      } catch {
        link.ws.close(1008, 'bad channel offer');
        return;
      }
      const sig = sign(this.hub.identity, SIG_DOMAIN.federation, {
        challenge: frame.challenge,
        from: this.hub.info.id,
        to: link.peer.id,
        offer: link.channelKeys.offer,
        answer,
      });
      sendJson(link.ws, { t: 'fed_auth', answer, sig, cursor: this.cursor(link.peer.id) });
      return;
    }
    if (frame.t === 'fed_auth') {
      if (!link.peer || !link.answeredSecret || !link.peerOffer) return;
      const ok = verifyPayload(
        link.peer.key,
        SIG_DOMAIN.federation,
        {
          challenge: link.challenge,
          from: link.peer.id,
          to: this.hub.info.id,
          offer: link.peerOffer,
          answer: frame.answer,
        },
        frame.sig,
      );
      if (!ok) {
        link.ws.close(1008, 'bad federation signature');
        return;
      }
      let accepted: Uint8Array;
      try {
        accepted = acceptChannel(link.channelKeys, frame.answer);
      } catch {
        link.ws.close(1008, 'bad channel answer');
        return;
      }
      // Both directions' secrets, ordered by server id so both sides agree.
      const self = this.hub.info.id;
      const lower = self < link.peer.id;
      const secret = lower
        ? concatBytes(accepted, link.answeredSecret)
        : concatBytes(link.answeredSecret, accepted);
      const ctx = lower ? `${self}|${link.peer.id}` : `${link.peer.id}|${self}`;
      link.channel = new SecureChannel(secret, ctx, lower);
      this.onAuthed(link, frame.cursor);
      return;
    }
    if (!link.authed || !link.peer) return;
    const peerId = link.peer.id;
    switch (frame.t) {
      case 'records':
        for (const item of frame.items)
          this.hub.records.put(item.record, { fresh: false, origin: peerId });
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
        this.send(link, { t: 'pong' });
        return;
      case 'mail_query':
        this.hub.mailbox.onQuery(peerId, frame.peer);
        return;
      case 'mail_ack':
        this.hub.mailbox.onRemoteAck(frame.peer, frame.ids);
        return;
      case 'link_query': {
        const found = this.hub.findLink(frame.code);
        this.send(link, {
          t: 'link_answer',
          qid: frame.qid,
          ...(found ? { found: { peer: found.peer, key: found.key, encKey: found.encKey } } : {}),
        });
        if (found) found.claimedBy = `remote:${peerId}`;
        return;
      }
      case 'link_answer': {
        const q = this.linkQueries.get(frame.qid);
        if (!q) return;
        q.pending -= 1;
        if (frame.found || q.pending <= 0) {
          this.linkQueries.delete(frame.qid);
          clearTimeout(q.timer);
          q.resolve(frame.found);
        }
        return;
      }
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

    this.send(link, { t: 'servers', servers: [this.hub.info, ...this.knownServers()] });
    this.send(link, { t: 'presence', full: true, entries: this.hub.presence.localEntries() });
    for (const v of this.hub.sessions.ownedVoiceFrames()) this.send(link, v);
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
        this.send(link, { t: 'records', items: batch, upTo });
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
      if (id !== origin) this.send(link, { t: 'records', items: [{ seq, record }], upTo: seq });
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
