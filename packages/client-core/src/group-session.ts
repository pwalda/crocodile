import { openSealed, seal, type Identity } from '@crocodile/crypto';
import {
  E2EEnvelope,
  GroupPayload,
  SealedPayload,
  utf8,
  type ChatMessage,
  type HostCaps,
  type PeerState,
  type RelayToClient,
  type SessionState,
  type SignalData,
} from '@crocodile/protocol';
import type { CoordinatorLink } from './coordinator-link';
import { Emitter } from './emitter';
import { GroupKeyring } from './keyring';
import type { MessageStore, PlatformAdapter, RelayHandle } from './platform';
import { RelayLink, type FrameCryptoHooks, type RelayLinkEvents, type RelayLinkOptions } from './relay-link';

/** What a GroupSession needs from the client around it. */
export interface SessionContext {
  identity: Identity;
  link: CoordinatorLink;
  platform: PlatformAdapter;
  messages: MessageStore;
  iceServers(): { urls: string }[];
  caps(): Promise<HostCaps>;
  /** X25519 key of a user from their verified profile. */
  encKeyOf(userId: string): Promise<string | null>;
  /** Whether a user may take part in the session (membership, blocks). */
  isAllowedPeer(sessionId: string, userId: string): boolean;
  /** Channels whose history belongs to the session. */
  historyChannels(sessionId: string): string[];
  /** Verify and store a chat message; resolves true if it was new. */
  acceptMessage(sessionId: string, message: ChatMessage): Promise<boolean>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface VoiceHooks {
  micTrack(): MediaStreamTrack | null;
  frameCrypto(keyring: GroupKeyring): FrameCryptoHooks | undefined;
}

/** Transport to the host relay; RelayLink in real clients, fakes in tests. */
export interface RelayTransport extends Emitter<RelayLinkEvents> {
  connect(): Promise<void>;
  handleSignal(data: SignalData): Promise<void>;
  send(msg: Parameters<RelayLink['send']>[0]): boolean;
  close(): void;
  readonly isOpen: boolean;
  setMicTrack?(track: MediaStreamTrack | null): Promise<void>;
}

export type TransportFactory = (opts: Omit<RelayLinkOptions, 'RTCPeerConnection'>) => RelayTransport;

export type RelayStatus = 'idle' | 'joining' | 'connecting' | 'connected' | 'reconnecting' | 'no-host' | 'left';

export type GroupSessionEvents = {
  update: void;
  track: { slot: number; track: MediaStreamTrack; receiver: RTCRtpReceiver };
  typing: { userId: string; ch: string };
  error: { message: string };
};

const HISTORY_CHUNK_BYTES = 96 * 1024;
const PENDING_TTL_MS = 15_000;

/**
 * One live P2P session (a space's text mesh, a voice channel or a DM).
 *
 * Follows the coordinator's session state: hosts the relay when elected,
 * connects to whoever hosts otherwise, and re-connects on failover. On top of
 * the relay it runs the end-to-end layer: sender-key exchange through sealed
 * boxes, group-encrypted chat, and history sync between peers.
 */
export class GroupSession extends Emitter<GroupSessionEvents> {
  state: SessionState | null = null;
  status: RelayStatus = 'idle';
  peers = new Map<string, PeerState>();
  speaking: string[] = [];
  slots: (string | null)[] = [];
  readonly keyring = new GroupKeyring();
  /** Negotiate audio with the relay (voice channels, DM calls). */
  isVoice = false;

  private hosting?: { epoch: number; handle: Promise<RelayHandle | null> };
  private transport?: { epoch: number; host: string; t: RelayTransport };
  private failures = 0;
  private reportedEpoch = -1;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private left = false;
  private pendingGroup: { from: string; env: Extract<E2EEnvelope, { k: 'group' }>; at: number }[] = [];
  private historyServedAt = new Map<string, number[]>();
  private historyAsked = new Set<string>();

  constructor(
    readonly sessionId: string,
    private readonly ctx: SessionContext,
    private readonly transportFactory: TransportFactory,
    private readonly voice?: VoiceHooks,
  ) {
    super();
    this.keyring.on('rotated', () => this.distributeKey());
  }

  get me() {
    return this.ctx.identity.userId;
  }

  get isHost() {
    return this.state?.host === this.me;
  }

  get connected() {
    return this.status === 'connected';
  }

  async join() {
    this.left = false;
    if (this.status === 'idle' || this.status === 'left') this.setStatus('joining');
    const caps = await this.ctx.caps();
    const { state } = await this.ctx.link.request('session.join', { sessionId: this.sessionId, caps });
    this.applyState(state);
  }

  async updateCaps() {
    if (this.left) return;
    const caps = await this.ctx.caps();
    await this.ctx.link.request('session.update', { sessionId: this.sessionId, caps }).catch(() => {});
  }

  async leave() {
    if (this.left) return;
    this.left = true;
    clearTimeout(this.retryTimer);
    this.closeTransport();
    this.stopHosting();
    this.setStatus('left');
    await this.ctx.link.request('session.leave', { sessionId: this.sessionId }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Session state from the coordinator
  // -------------------------------------------------------------------------

  applyState(state: SessionState) {
    if (this.left || state.id !== this.sessionId) return;
    if (this.state && state.epoch < this.state.epoch) return;
    this.state = state;
    if (state.host === this.me) {
      if (!this.hosting || this.hosting.epoch !== state.epoch) this.startHosting(state);
    } else if (this.hosting) {
      this.stopHosting();
    }
    if (!state.host) {
      this.closeTransport();
      this.setStatus('no-host');
    } else if (!this.transport || this.transport.epoch !== state.epoch || this.transport.host !== state.host) {
      this.failures = 0;
      this.connectTransport();
    }
    this.emit('update', undefined);
  }

  private startHosting(state: SessionState) {
    this.stopHosting();
    const adapter = this.ctx.platform.relay;
    if (!adapter) return;
    const sessionId = this.sessionId;
    const handle = adapter
      .start({
        sessionId,
        epoch: state.epoch,
        identity: this.ctx.identity,
        slots: state.relaySlots,
        iceServers: this.ctx.iceServers(),
        members: () => (this.state?.members ?? []).map((m) => m.userId).filter((u) => this.ctx.isAllowedPeer(sessionId, u)),
        sendSignal: (to, data) => {
          void this.ctx.link.request('signal.send', { to, sessionId, data }).catch(() => {});
        },
      })
      .catch((err) => {
        this.ctx.log('failed to start relay', { err: String(err) });
        return null;
      });
    this.hosting = { epoch: state.epoch, handle };
    this.ctx.log('hosting relay', { sessionId, epoch: state.epoch });
    const early = this.earlyRelaySignals.filter((s) => s.data.epoch === state.epoch);
    this.earlyRelaySignals = [];
    for (const s of early) void handle.then((r) => r?.handleSignal(s.from, s.data));
  }

  private stopHosting() {
    const h = this.hosting;
    this.hosting = undefined;
    void h?.handle.then((r) => r?.close());
  }

  /** Offers can beat our own copy of the session state that makes us host. */
  private earlyRelaySignals: { from: string; data: SignalData; at: number }[] = [];

  handleSignal(from: string, data: SignalData) {
    const toRelay = data.type === 'offer' || ((data.type === 'candidate' || data.type === 'bye') && data.dir === 'toRelay');
    if (toRelay) {
      const h = this.hosting;
      if (h && h.epoch === data.epoch) void h.handle.then((r) => r?.handleSignal(from, data));
      else if (!h || h.epoch < data.epoch) {
        const now = Date.now();
        this.earlyRelaySignals = this.earlyRelaySignals.filter((s) => now - s.at < 5000).slice(-200);
        this.earlyRelaySignals.push({ from, data, at: now });
      }
      return;
    }
    const t = this.transport;
    if (t && t.host === from && t.epoch === data.epoch) void t.t.handleSignal(data);
  }

  // -------------------------------------------------------------------------
  // Connection to the host relay
  // -------------------------------------------------------------------------

  private connectTransport() {
    this.closeTransport();
    const state = this.state;
    if (!state?.host || this.left) return;
    const slots = this.voice && this.isVoice ? state.relaySlots : 0;
    const t = this.transportFactory({
      identity: this.ctx.identity,
      sessionId: this.sessionId,
      epoch: state.epoch,
      host: state.host,
      iceServers: this.ctx.iceServers(),
      slots,
      micTrack: this.voice?.micTrack() ?? null,
      crypto: slots > 0 ? this.voice?.frameCrypto(this.keyring) : undefined,
      sendSignal: (data) => this.ctx.link.request('signal.send', { to: state.host!, sessionId: this.sessionId, data }),
    });
    const entry = { epoch: state.epoch, host: state.host, t };
    this.transport = entry;
    this.peers.clear();
    this.slots = [];
    this.speaking = [];
    this.setStatus(this.failures > 0 ? 'reconnecting' : 'connecting');

    t.on('open', () => {
      if (this.transport !== entry) return;
      this.failures = 0;
      this.setStatus('connected');
      t.send({ t: 'state', muted: this.voiceState.muted, deafened: this.voiceState.deafened });
    });
    t.on('message', (msg) => {
      if (this.transport === entry) this.onRelayMessage(msg);
    });
    t.on('track', (ev) => this.emit('track', ev));
    t.on('failed', ({ reason }) => {
      if (this.transport !== entry) return;
      this.transport = undefined;
      this.ctx.log('relay connection failed', { sessionId: this.sessionId, reason });
      this.failures += 1;
      this.setStatus('reconnecting');
      if (this.failures >= 2 && this.reportedEpoch !== entry.epoch && entry.host !== this.me) {
        this.reportedEpoch = entry.epoch;
        void this.ctx.link
          .request('session.report', { sessionId: this.sessionId, epoch: entry.epoch, issue: 'host_unreachable' })
          .catch(() => {});
      }
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (!this.left && this.state?.epoch === entry.epoch) this.connectTransport();
      }, Math.min(10_000, 500 * 2 ** this.failures));
    });
    t.connect().catch((err) => {
      this.ctx.log('relay connect error', { err: String(err) });
      t.emit('failed', { reason: String(err) });
    });
  }

  private closeTransport() {
    const t = this.transport;
    this.transport = undefined;
    t?.t.close();
  }

  voiceState = { muted: false, deafened: false };

  setVoiceState(muted: boolean, deafened: boolean) {
    this.voiceState = { muted, deafened };
    this.transport?.t.send({ t: 'state', muted, deafened });
  }

  async setMicTrack(track: MediaStreamTrack | null) {
    await this.transport?.t.setMicTrack?.(track);
  }

  // -------------------------------------------------------------------------
  // Relay messages and the end-to-end layer
  // -------------------------------------------------------------------------

  private onRelayMessage(msg: RelayToClient) {
    switch (msg.t) {
      case 'hello':
        this.peers = new Map(msg.peers.map((p) => [p.userId, p]));
        this.slots = new Array(msg.slots).fill(null);
        this.historyAsked.clear();
        for (const p of msg.peers) this.onPeerPresent(p.userId);
        this.requestHistory([...this.peers.keys()]);
        break;
      case 'peer_join':
        this.peers.set(msg.peer.userId, msg.peer);
        this.onPeerPresent(msg.peer.userId);
        if (this.isDm) this.requestHistory([msg.peer.userId]);
        break;
      case 'peer_leave':
        this.peers.delete(msg.userId);
        this.keyring.peerLeft(msg.userId);
        this.keyring.rotate();
        break;
      case 'peer_state':
        if (this.peers.has(msg.peer.userId)) this.peers.set(msg.peer.userId, msg.peer);
        break;
      case 'slots':
        this.slots = msg.map;
        break;
      case 'speaking':
        this.speaking = msg.users;
        break;
      case 'msg':
        void this.onEnvelope(msg.from, msg.d);
        return;
      case 'pong':
        return;
    }
    this.emit('update', undefined);
  }

  get isDm() {
    return this.sessionId.startsWith('dm:');
  }

  private onPeerPresent(userId: string) {
    if (!this.ctx.isAllowedPeer(this.sessionId, userId)) {
      this.ctx.log('ignoring peer that is not allowed in this session', { userId });
      return;
    }
    void this.sendKeyTo(userId);
  }

  private distributeKey() {
    for (const userId of this.peers.keys()) {
      if (this.ctx.isAllowedPeer(this.sessionId, userId)) void this.sendKeyTo(userId);
    }
  }

  private async sendKeyTo(userId: string) {
    const { kid, key } = this.keyring.exportMine();
    await this.sendSealed(userId, { type: 'sender_key', sessionId: this.sessionId, kid, key });
  }

  private async sendSealed(to: string, payload: SealedPayload): Promise<boolean> {
    const encKey = await this.ctx.encKeyOf(to);
    if (!encKey || !this.transport) return false;
    const box = seal(this.ctx.identity, encKey, utf8.encode(JSON.stringify(payload)));
    return this.transport.t.send({ t: 'direct', to, d: { k: 'sealed', box } });
  }

  sendGroup(payload: GroupPayload): boolean {
    if (!this.transport?.t.isOpen) return false;
    const env = this.keyring.encrypt(utf8.encode(JSON.stringify(payload)));
    return this.transport.t.send({ t: 'bcast', d: { k: 'group', ...env } });
  }

  private async onEnvelope(from: string, raw: unknown) {
    const parsed = E2EEnvelope.safeParse(raw);
    if (!parsed.success) return;
    const env = parsed.data;
    if (env.k === 'sealed') {
      const opened = openSealed(this.ctx.identity, env.box);
      if (!opened || opened.from !== from) return;
      let payload: SealedPayload;
      try {
        payload = SealedPayload.parse(JSON.parse(utf8.decode(opened.plaintext)));
      } catch {
        return;
      }
      await this.onSealed(from, payload);
      return;
    }
    const result = this.keyring.decrypt(env.kid, env.n, env.ct);
    if (!result) {
      this.pendingGroup.push({ from, env, at: Date.now() });
      if (this.pendingGroup.length > 500) this.pendingGroup.shift();
      return;
    }
    if (result.userId !== from) return;
    await this.onGroupPlaintext(from, result.plaintext);
  }

  private async onSealed(from: string, payload: SealedPayload) {
    switch (payload.type) {
      case 'sender_key':
        if (payload.sessionId !== this.sessionId || !this.ctx.isAllowedPeer(this.sessionId, from)) return;
        this.keyring.addPeerKey(from, payload.kid, payload.key);
        await this.flushPending();
        return;
      case 'history_req':
        await this.serveHistory(from, payload.since);
        return;
      case 'history':
        for (const m of payload.messages) await this.ctx.acceptMessage(this.sessionId, m);
        return;
      case 'message':
        await this.ctx.acceptMessage(this.sessionId, payload.message);
        return;
    }
  }

  private async onGroupPlaintext(from: string, plaintext: Uint8Array) {
    let payload: GroupPayload;
    try {
      payload = GroupPayload.parse(JSON.parse(utf8.decode(plaintext)));
    } catch {
      return;
    }
    if (payload.type === 'message') {
      if (payload.message.author !== from) return;
      await this.ctx.acceptMessage(this.sessionId, payload.message);
    } else if (payload.type === 'typing') {
      this.emit('typing', { userId: from, ch: payload.ch });
    }
  }

  private async flushPending() {
    const now = Date.now();
    const queue = this.pendingGroup.filter((p) => now - p.at < PENDING_TTL_MS);
    this.pendingGroup = [];
    for (const p of queue) {
      const result = this.keyring.decrypt(p.env.kid, p.env.n, p.env.ct);
      if (!result) this.pendingGroup.push(p);
      else if (result.userId === p.from) await this.onGroupPlaintext(p.from, result.plaintext);
    }
  }

  // -------------------------------------------------------------------------
  // History sync
  // -------------------------------------------------------------------------

  private requestHistory(candidates: string[]) {
    const channels = this.ctx.historyChannels(this.sessionId);
    if (channels.length === 0) return;
    const st = this.state;
    const preferred = [st?.host, st?.backup, ...candidates].filter(
      (u): u is string => !!u && u !== this.me && this.peers.has(u) && !this.historyAsked.has(u),
    );
    const targets = [...new Set(preferred)].slice(0, 2);
    if (targets.length === 0) return;
    void (async () => {
      const since: Record<string, number> = {};
      for (const ch of channels) since[ch] = await this.ctx.messages.latestTs(ch);
      for (const t of targets) {
        this.historyAsked.add(t);
        await this.sendSealed(t, { type: 'history_req', since });
      }
    })();
  }

  private async serveHistory(to: string, since: Record<string, number>) {
    if (!this.ctx.isAllowedPeer(this.sessionId, to)) return;
    // Throttle: at most 5 history replies per peer per 10 seconds.
    const now = Date.now();
    const recent = (this.historyServedAt.get(to) ?? []).filter((t) => now - t < 10_000);
    if (recent.length >= 5) return;
    this.historyServedAt.set(to, [...recent, now]);
    const allowed = new Set(this.ctx.historyChannels(this.sessionId));
    const out: ChatMessage[] = [];
    for (const [ch, after] of Object.entries(since)) {
      if (!allowed.has(ch)) continue;
      out.push(...(await this.ctx.messages.since(ch, after, 500)));
    }
    let chunk: ChatMessage[] = [];
    let size = 0;
    const flush = async (done: boolean) => {
      await this.sendSealed(to, { type: 'history', messages: chunk, done });
      chunk = [];
      size = 0;
    };
    for (const m of out) {
      const bytes = m.body.length * 3 + 400;
      if (size + bytes > HISTORY_CHUNK_BYTES && chunk.length) await flush(false);
      chunk.push(m);
      size += bytes;
    }
    await flush(true);
  }

  private setStatus(status: RelayStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit('update', undefined);
  }
}

export function defaultTransportFactory(platform: PlatformAdapter): TransportFactory | undefined {
  const rtc = platform.rtc;
  if (!rtc) return undefined;
  return (opts) => new RelayLink({ ...opts, RTCPeerConnection: rtc.RTCPeerConnection });
}
