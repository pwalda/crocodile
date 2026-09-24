import type { WebSocket } from 'ws';
import {
  acceptChannel,
  createChannelKeys,
  randomId,
  SecureChannel,
  sign,
  userIdFromKey,
  verifyPayload,
  type ChannelKeys,
} from '@crocodile/crypto';
import {
  ClientAuth,
  RpcParams,
  SIG_DOMAIN,
  peerIds,
  type LinkBox,
  type Platform,
  type RpcMethod,
  type ServerEvents,
  type ServerFrame,
  type SignedRecord,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import type { ClientHandle, OwnStatus } from './presence';
import { RateLimiter, RpcFailure, sendJson } from './util';

let nextConnId = 1;

/**
 * One client WebSocket (one device). The server greets with a signed hello
 * carrying fresh hybrid (X25519 + ML-KEM-768) channel keys; the client
 * answers with its half and a signature binding its identity, device and
 * channel. Every later frame is AES-256-GCM encrypted and length-padded.
 */
export class ClientConnection implements ClientHandle {
  readonly connId = nextConnId++;
  userId = '';
  deviceId = '';
  peer = '';
  publicKey = '';
  /** X25519 key of this identity (only used for device linking). */
  encKey = '';
  platform: Platform = 'desktop';
  connectedAt = Date.now();
  status: OwnStatus = 'online';
  statusText?: string;
  subscriptions = new Set<string>();
  presenceWatch = new Set<string>();
  voiceWatch = new Set<string>();

  private authed = false;
  private channel?: SecureChannel;
  private readonly channelKeys: ChannelKeys = createChannelKeys();
  private readonly challenge = randomId(16);
  private readonly limiter = new RateLimiter(30, 120);
  private readonly writeLimiter = new RateLimiter(5, 40);
  private readonly linkLimiter = new RateLimiter(0.2, 5);
  private alive = true;
  private pingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: Coordinator,
    private readonly ws: WebSocket,
  ) {
    const time = Date.now();
    const info = hub.info;
    const channel = this.channelKeys.offer;
    this.frame({
      t: 'hello',
      server: info,
      challenge: this.challenge,
      stun: hub.stunUrls(),
      time,
      channel,
      sig: sign(hub.identity, SIG_DOMAIN.serverHello, {
        challenge: this.challenge,
        server: info.id,
        time,
        channel,
      }),
    });
    const authTimer = setTimeout(() => {
      if (!this.authed) ws.close(4001, 'authentication timeout');
    }, 15_000);
    authTimer.unref?.();

    ws.on('message', (raw) => {
      if (!this.limiter.take()) {
        this.frame({ t: 'error', err: { code: 'rate_limited', message: 'slow down' } });
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(1003, 'invalid json');
        return;
      }
      if (!this.authed) return this.onAuth(msg);
      const f = msg as { t?: unknown; n?: unknown; c?: unknown };
      if (f.t !== 'x' || typeof f.n !== 'number' || typeof f.c !== 'string')
        return ws.close(1008, 'expected encrypted frame');
      const inner = this.channel!.open({ n: f.n, c: f.c });
      if (inner === undefined) return ws.close(1008, 'bad frame');
      void this.onRequest(inner);
    });
    ws.on('pong', () => (this.alive = true));
    this.pingTimer = setInterval(() => {
      if (!this.alive) return ws.terminate();
      this.alive = false;
      ws.ping();
    }, 25_000);
    this.pingTimer.unref?.();
    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(this.pingTimer);
      if (this.authed) hub.onClientClosed(this);
    });
    ws.on('error', () => {});
  }

  private frame(f: ServerFrame) {
    sendJson(this.ws, this.channel ? this.channel.seal(f) : f);
  }

  send<E extends keyof ServerEvents>(ev: E, d: ServerEvents[E]) {
    this.frame({ t: 'ev', ev, d });
  }

  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }

  private onAuth(msg: unknown) {
    const parsed = ClientAuth.safeParse(msg);
    if (!parsed.success) {
      this.ws.close(4002, 'expected auth');
      return;
    }
    const { key, sig, client, device, channel } = parsed.data;
    const ok = verifyPayload(
      key,
      SIG_DOMAIN.auth,
      { challenge: this.challenge, server: this.hub.info.id, device, channel },
      sig,
    );
    if (!ok) {
      this.frame({ t: 'error', err: { code: 'unauthorized', message: 'bad signature' } });
      this.ws.close(4003, 'unauthorized');
      return;
    }
    let secret: Uint8Array;
    try {
      secret = acceptChannel(this.channelKeys, channel);
    } catch {
      this.ws.close(4003, 'bad channel');
      return;
    }
    this.userId = userIdFromKey(key);
    this.deviceId = device;
    this.peer = peerIds.make(this.userId, device);
    this.publicKey = key;
    this.platform = client.platform;
    this.channel = new SecureChannel(
      secret,
      `${this.challenge}|${this.hub.info.id}|${this.peer}`,
      false,
    );
    this.authed = true;
    this.connectedAt = Date.now();
    this.frame({ t: 'auth_ok', userId: this.userId, peer: this.peer });
    this.hub.onClientAuthed(this);
  }

  private async onRequest(msg: unknown) {
    const req = msg as { t?: unknown; id?: unknown; m?: unknown; p?: unknown };
    if (req.t !== 'req' || typeof req.id !== 'number' || typeof req.m !== 'string') return;
    const id = req.id;
    try {
      if (!(req.m in RpcParams)) throw new RpcFailure('not_found', `unknown method ${req.m}`);
      const method = req.m as RpcMethod;
      const parsed = RpcParams[method].safeParse(req.p ?? {});
      if (!parsed.success)
        throw new RpcFailure('bad_request', parsed.error.issues[0]?.message ?? 'invalid params');
      const result = await this.dispatch(method, parsed.data as never);
      this.frame({ t: 'res', id, ok: result });
    } catch (err) {
      if (err instanceof RpcFailure)
        this.frame({ t: 'res', id, err: { code: err.code, message: err.message } });
      else {
        this.hub.log.error('rpc failed', { method: req.m, err: String(err) });
        this.frame({ t: 'res', id, err: { code: 'internal', message: 'internal error' } });
      }
    }
  }

  private async dispatch(method: RpcMethod, p: Record<string, never>): Promise<unknown> {
    const hub = this.hub;
    const store = hub.records.store;
    switch (method) {
      case 'records.put': {
        if (!this.writeLimiter.take()) throw new RpcFailure('rate_limited', 'too many writes');
        const { record } = p as unknown as { record: SignedRecord };
        const r = hub.records.put(record, { fresh: true, origin: null });
        return {
          accepted: r.accepted,
          current: r.current,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      case 'records.get': {
        const { keys } = p as unknown as { keys: string[] };
        return { records: keys.map((k) => store.get(k)).filter(Boolean) };
      }
      case 'records.list': {
        const { prefix, limit } = p as unknown as { prefix: string; limit?: number };
        return { records: store.listPrefix(prefix, limit ?? 1000) };
      }
      case 'records.subscribe': {
        const { prefixes } = p as unknown as { prefixes: string[] };
        for (const prefix of prefixes) this.subscriptions.add(prefix);
        return {};
      }
      case 'users.search': {
        const { query } = p as unknown as { query: string };
        return { profiles: hub.searchUsers(query) };
      }
      case 'friends.incoming':
        return { records: store.findByTerm(`friend-of:${this.userId}`, 2000) };
      case 'spaces.mine': {
        const members = store.findByTerm(
          `member-user:${this.userId}`,
          1000,
        ) as SignedRecord<'member'>[];
        const spaceIds = new Set(members.map((m) => m.body.spaceId));
        const spaces = [...spaceIds]
          .map((id) => store.get(`space:${id}`))
          .filter((s): s is SignedRecord<'space'> => !!s && s.kind === 'space');
        return { spaces, members };
      }
      case 'presence.subscribe': {
        const { userIds } = p as unknown as { userIds: string[] };
        return { presence: hub.presence.watch(this, userIds) };
      }
      case 'presence.set': {
        const { status, text } = p as unknown as { status: OwnStatus; text?: string };
        hub.presence.setStatus(this, status, text);
        return {};
      }
      case 'session.join': {
        const { sessionId, caps } = p as unknown as { sessionId: string; caps: never };
        return { state: await hub.sessions.join(this, sessionId, caps) };
      }
      case 'session.leave': {
        const { sessionId } = p as unknown as { sessionId: string };
        await hub.sessions.leave(this.peer, sessionId);
        return {};
      }
      case 'session.update': {
        const { sessionId, caps } = p as unknown as { sessionId: string; caps: never };
        await hub.sessions.update(this, sessionId, caps);
        return {};
      }
      case 'session.report': {
        const { sessionId, epoch } = p as unknown as { sessionId: string; epoch: number };
        await hub.sessions.report(this, sessionId, epoch);
        return {};
      }
      case 'voice.watch': {
        const { spaceIds } = p as unknown as { spaceIds: string[] };
        for (const id of spaceIds) {
          if (!hub.isSpaceMember(id, this.userId))
            throw new RpcFailure('forbidden', 'not a member of that space');
        }
        this.voiceWatch = new Set(spaceIds);
        return { voice: hub.sessions.voiceSnapshot(spaceIds) };
      }
      case 'signal.send': {
        const { to, sessionId, data } = p as unknown as {
          to: string;
          sessionId: string;
          data: never;
        };
        if (!hub.sessions.inSession(this.peer, sessionId))
          throw new RpcFailure('forbidden', 'join the session first');
        return { delivered: hub.deliverToPeer(to, 'signal', { from: this.peer, sessionId, data }) };
      }
      case 'servers.list':
        return { servers: [hub.info, ...hub.mesh.knownServers()] };
      case 'link.open': {
        const { encKey } = p as unknown as { encKey: string };
        this.encKey = encKey;
        return hub.openLink(this);
      }
      case 'link.claim': {
        if (!this.linkLimiter.take())
          throw new RpcFailure('rate_limited', 'too many attempts; wait a minute');
        const { code } = p as unknown as { code: string };
        return hub.claimLink(this, code);
      }
      case 'link.send': {
        const { code, box } = p as unknown as { code: string; box: LinkBox };
        hub.sendLink(this, code, box);
        return {};
      }
      case 'relay.request': {
        const { sessionId } = p as unknown as { sessionId: string };
        return { grant: hub.requestRelay(this, sessionId) };
      }
      case 'relay.release':
        hub.endRelay(this.userId, 'released');
        return {};
    }
  }

  /** True if this client subscribed to a prefix covering the record key. */
  wants(record: SignedRecord): boolean {
    for (const prefix of this.subscriptions) if (record.key.startsWith(prefix)) return true;
    return false;
  }
}
