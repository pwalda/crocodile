import type { WebSocket } from 'ws';
import { randomId, sign, userIdFromKey, verifyPayload } from '@crocodile/crypto';
import {
  ClientAuth,
  RpcParams,
  SIG_DOMAIN,
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

/** One client WebSocket: challenge-response login, then JSON RPC + events. */
export class ClientConnection implements ClientHandle {
  readonly connId = nextConnId++;
  userId = '';
  platform: Platform = 'desktop';
  connectedAt = Date.now();
  status: OwnStatus = 'online';
  statusText?: string;
  subscriptions = new Set<string>();
  presenceWatch = new Set<string>();
  voiceWatch = new Set<string>();

  private authed = false;
  private readonly challenge = randomId(16);
  private readonly limiter = new RateLimiter(30, 120);
  private readonly writeLimiter = new RateLimiter(5, 40);
  private alive = true;
  private pingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly hub: Coordinator,
    private readonly ws: WebSocket,
  ) {
    const time = Date.now();
    const info = hub.info;
    this.frame({
      t: 'hello',
      server: info,
      challenge: this.challenge,
      stun: hub.stunUrls(),
      time,
      sig: sign(hub.identity, SIG_DOMAIN.serverHello, { challenge: this.challenge, server: info.id, time }),
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
      if (!this.authed) this.onAuth(msg);
      else void this.onRequest(msg);
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
    sendJson(this.ws, f);
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
    const { key, sig, client } = parsed.data;
    const ok = verifyPayload(key, SIG_DOMAIN.auth, { challenge: this.challenge, server: this.hub.info.id }, sig);
    if (!ok) {
      this.frame({ t: 'error', err: { code: 'unauthorized', message: 'bad signature' } });
      this.ws.close(4003, 'unauthorized');
      return;
    }
    this.userId = userIdFromKey(key);
    this.platform = client.platform;
    this.authed = true;
    this.connectedAt = Date.now();
    this.frame({ t: 'auth_ok', userId: this.userId });
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
      if (!parsed.success) throw new RpcFailure('bad_request', parsed.error.issues[0]?.message ?? 'invalid params');
      const result = await this.dispatch(method, parsed.data as never);
      this.frame({ t: 'res', id, ok: result });
    } catch (err) {
      if (err instanceof RpcFailure) this.frame({ t: 'res', id, err: { code: err.code, message: err.message } });
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
        return { accepted: r.accepted, current: r.current, ...(r.reason ? { reason: r.reason } : {}) };
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
        const members = store.findByTerm(`member-user:${this.userId}`, 1000) as SignedRecord<'member'>[];
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
        await hub.sessions.leave(this.userId, sessionId);
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
          if (!hub.isSpaceMember(id, this.userId)) throw new RpcFailure('forbidden', 'not a member of that space');
        }
        this.voiceWatch = new Set(spaceIds);
        return { voice: hub.sessions.voiceSnapshot(spaceIds) };
      }
      case 'signal.send': {
        const { to, sessionId, data } = p as unknown as { to: string; sessionId: string; data: never };
        if (!hub.sessions.inSession(this.userId, sessionId)) throw new RpcFailure('forbidden', 'join the session first');
        return { delivered: hub.deliver(to, 'signal', { from: this.userId, sessionId, data }) };
      }
      case 'servers.list':
        return { servers: [hub.info, ...hub.mesh.knownServers()] };
    }
  }

  /** True if this client subscribed to a prefix covering the record key. */
  wants(record: SignedRecord): boolean {
    for (const prefix of this.subscriptions) if (record.key.startsWith(prefix)) return true;
    return false;
  }
}

