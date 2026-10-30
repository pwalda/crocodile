import {
  answerChannel,
  SecureChannel,
  signInChannelContext,
  sign,
  signSessionOp,
  verifyPayload,
  type Identity,
} from '@crocodile/crypto';
import {
  OperatorInfo,
  SIG_DOMAIN,
  helloFullPayload,
  type ClientAuthBody,
  type Platform,
  type RpcError,
  type RpcMethod,
  type RpcMethods,
  type RpcParamsOf,
  type SessionOpProof,
  type ServerEvents,
  type ServerFrame,
  type ServerHello,
  type ServerInfo,
  type SignedRecord,
} from '@crocodile/protocol';
import { Emitter } from './emitter';

export class RpcCallError extends Error {
  constructor(
    readonly code: RpcError['code'],
    message: string,
    /** For account_deleted: the server's proof, unverified until checked. */
    readonly record?: SignedRecord,
  ) {
    super(message);
  }
}

export type ConnectionEvents = ServerEvents & {
  close: { code: number; reason: string };
};

export interface ConnectOptions {
  url: string;
  identity: Identity;
  /** This installation's device id. */
  deviceId: string;
  platform: Platform;
  version: string;
  /** If known (from the directory), the server must prove it holds this key. */
  expectedServerKey?: string;
  timeoutMs?: number;
  /** WebSocket implementation; defaults to the global one. */
  WebSocketImpl?: typeof WebSocket;
}

function wsUrl(httpUrl: string) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/v1/client';
  return u.toString();
}

/**
 * One authenticated WebSocket to a coordination server. Reconnection and
 * fail-over between servers live a level up, in CoordinatorLink.
 */
export class CoordinatorConnection extends Emitter<ConnectionEvents> {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  /** How many times we have left each room on this connection: an answer from before that is no news. */
  private lineage = new Map<string, number>();
  /**
   * What the server has taken from us in each room on this connection: the time of the join
   * (what later operations name) and how many updates followed, and the latest join, while it is
   * on its way. A join counts only once it is taken.
   */
  private signing = new Map<string, { since?: number; n: number; joining?: Promise<unknown> }>();
  /**
   * The time of the last join signed for each room, across connections to the same server: it
   * only goes up. (Per server: the time of another is of no concern to this one.)
   */
  private static joinedAt = new Map<string, number>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly channel: SecureChannel,
    readonly server: ServerInfo,
    readonly stun: string[],
    readonly userId: string,
    /** `<userId>.<deviceId>` */
    readonly peer: string,
    /** Who runs the server, as it says; dropped unless well-formed. */
    readonly operator?: OperatorInfo,
    /** What signs what we ask of a session (the account's key). */
    private readonly signer?: Pick<Identity, 'signSecret'>,
    /** How far the server's clock is ahead of ours: a join is dated by the server's clock, which is the one it is checked by. */
    private readonly clockOffset = 0,
  ) {
    super();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => this.onClose(ev.code, ev.reason);
  }

  static connect(opts: ConnectOptions): Promise<CoordinatorConnection> {
    const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    return new Promise((resolve, reject) => {
      const ws = new WS(wsUrl(opts.url));
      let hello: ServerHello | undefined;
      /** How far the server's clock is ahead of ours, from the time in its hello. */
      let clockOffset = 0;
      let channel: SecureChannel | undefined;
      const fail = (err: Error) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new Error(`timed out connecting to ${opts.url}`)),
        opts.timeoutMs ?? 10_000,
      );
      ws.onerror = () => fail(new Error(`cannot reach ${opts.url}`));
      ws.onclose = (ev) => fail(new Error(`connection closed: ${ev.reason || ev.code}`));
      ws.onmessage = (ev) => {
        let frame: ServerFrame | { t: 'x'; n: number; c: string };
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return fail(new Error('invalid frame from server'));
        }
        if (frame.t === 'x') {
          const inner = channel?.open(frame) as ServerFrame | undefined;
          if (!inner) return fail(new Error('could not decrypt server frame'));
          frame = inner;
        }
        if (frame.t === 'hello' && !hello) {
          hello = frame;
          clockOffset = Number.isFinite(frame.time) ? frame.time - Date.now() : 0;
          const ok = verifyPayload(
            frame.server.key,
            SIG_DOMAIN.serverHello,
            {
              challenge: frame.challenge,
              server: frame.server.id,
              time: frame.time,
              channel: frame.channel,
            },
            frame.sig,
          );
          if (!ok) return fail(new Error('server failed to prove its identity'));
          // The rest of the hello (STUN servers, operator) counts only when
          // the server signed it too. Unsigned (a server too old to sign it)
          // or changed on the way, none of it is used.
          const signedFull =
            typeof frame.sigFull === 'string' &&
            verifyPayload(
              frame.server.key,
              SIG_DOMAIN.serverHelloFull,
              helloFullPayload(frame),
              frame.sigFull,
            );
          hello = signedFull ? frame : { ...frame, stun: [], operator: undefined };
          if (opts.expectedServerKey && opts.expectedServerKey !== frame.server.key) {
            return fail(new Error('server key does not match the directory listing'));
          }
          let answer: { epk: string; kem: string };
          let authChannel: SecureChannel;
          try {
            const res = answerChannel(frame.channel);
            answer = res.answer;
            // Who we are goes sealed, under keys of their own (the server learns our peer id
            // only from it, and the channel for the rest of the connection includes it).
            authChannel = new SecureChannel(
              res.secret,
              signInChannelContext(frame.challenge, frame.server.id),
              true,
            );
            const peer = `${opts.identity.userId}.${opts.deviceId}`;
            channel = new SecureChannel(
              res.secret,
              `${frame.challenge}|${frame.server.id}|${peer}`,
              true,
            );
          } catch {
            return fail(new Error('server offered an invalid channel'));
          }
          const body: ClientAuthBody = {
            key: opts.identity.publicKey,
            device: opts.deviceId,
            sig: sign(opts.identity, SIG_DOMAIN.auth, {
              challenge: frame.challenge,
              server: frame.server.id,
              device: opts.deviceId,
              channel: answer,
            }),
            client: { platform: opts.platform, version: opts.version },
          };
          const { n, c } = authChannel.seal(body);
          ws.send(JSON.stringify({ t: 'auth', channel: answer, sealed: { n, c } }));
        } else if (frame.t === 'auth_ok' && hello && channel) {
          clearTimeout(timer);
          ws.onerror = null;
          resolve(
            new CoordinatorConnection(
              ws,
              channel,
              hello.server,
              hello.stun,
              frame.userId,
              frame.peer,
              OperatorInfo.safeParse(hello.operator).data,
              opts.identity,
              clockOffset,
            ),
          );
        } else if (frame.t === 'error') {
          fail(new RpcCallError(frame.err.code, frame.err.message, frame.err.record));
        }
      };
    });
  }

  get isOpen() {
    return !this.closed;
  }

  request<M extends RpcMethod>(
    method: M,
    params: RpcParamsOf<M>,
    timeoutMs = 15_000,
  ): Promise<RpcMethods[M]> {
    if (method === 'session.join' || method === 'session.update' || method === 'session.report')
      return this.signedRequest(
        method,
        params as RpcParamsOf<'session.join' | 'session.update' | 'session.report'>,
        timeoutMs,
      ) as Promise<RpcMethods[M]>;
    const sent = this.send(method, params, timeoutMs);
    if (method === 'session.leave') this.forget((params as RpcParamsOf<'session.leave'>).sessionId);
    return sent;
  }

  private forget(sessionId: string) {
    this.signing.delete(sessionId);
    this.lineage.set(sessionId, (this.lineage.get(sessionId) ?? 0) + 1);
  }

  private send<M extends RpcMethod>(
    method: M,
    params: RpcParamsOf<M>,
    timeoutMs: number,
  ): Promise<RpcMethods[M]> {
    if (this.closed) return Promise.reject(new RpcCallError('unavailable', 'not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCallError('unavailable', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify(this.channel.seal({ t: 'req', id, m: method, p: params })));
    });
  }

  /**
   * A join, update or report, with the account's signature on it, made now and for this very
   * server, so that no other can speak for this device. An update or a report goes after a join
   * of the same room that is on its way (it names that join).
   */
  private async signedRequest(
    method: 'session.join' | 'session.update' | 'session.report',
    params: RpcParamsOf<'session.join' | 'session.update' | 'session.report'>,
    timeoutMs: number,
  ): Promise<unknown> {
    // Already signed (or by someone that wants to be refused): as it is.
    if (!this.signer || (params as { proof?: unknown }).proof)
      return this.send(method, params, timeoutMs);
    const { sessionId } = params;
    if (method !== 'session.join') await this.signing.get(sessionId)?.joining?.catch(() => {});
    const room = this.signing.get(sessionId);
    let proof: SessionOpProof | undefined;
    if (method === 'session.join') {
      const p = params as RpcParamsOf<'session.join'>;
      const key = `${this.server.id}|${this.peer}|${sessionId}`;
      // Each join is later than the last, whatever the clock does: it is what the others name.
      const joined = CoordinatorConnection.joinedAt;
      const at = Math.max(Date.now() + this.clockOffset, (joined.get(key) ?? 0) + 1);
      joined.set(key, at);
      // Of no use once it is too old for a join to be taken after it anyway.
      // (Only this server's: the times of another are by another clock.)
      const mine = `${this.server.id}|`;
      for (const [k, v] of joined)
        if (k.startsWith(mine) && v < Date.now() + this.clockOffset - 15 * 60_000) joined.delete(k);
      proof = signSessionOp(
        this.signer,
        sessionId,
        this.peer,
        { op: 'join', caps: p.caps },
        { server: this.server.id, at },
      );
      const joining: Promise<unknown> = this.send(method, { ...p, proof }, timeoutMs);
      const entry = {
        ...this.signing.get(sessionId),
        n: this.signing.get(sessionId)?.n ?? 0,
        joining,
      };
      this.signing.set(sessionId, entry);
      // Taken: later operations name this join (the latest of those taken, if they come back out of turn).
      const lineage = this.lineage.get(sessionId) ?? 0;
      void joining.then(
        () => {
          const now = this.signing.get(sessionId);
          // (Not an answer from before we left the room.)
          if ((this.lineage.get(sessionId) ?? 0) !== lineage) return;
          if (now && (now.since === undefined || at > now.since)) {
            now.since = at;
            now.n = 0;
          }
        },
        () => {},
      );
      return joining;
    }
    // Not in the room as far as we know: the server says so.
    // No join of ours has been taken (one that is on its way failed, or its answer never came): we are not in it.
    if (!room || room.since === undefined)
      return Promise.reject(new RpcCallError('not_found', 'not in session'));
    if (method === 'session.update') {
      const p = params as RpcParamsOf<'session.update'>;
      proof = signSessionOp(
        this.signer,
        sessionId,
        this.peer,
        { op: 'update', caps: p.caps },
        { server: this.server.id, since: room.since, n: ++room.n },
      );
      return this.send(method, { ...p, proof }, timeoutMs);
    }
    const p = params as RpcParamsOf<'session.report'>;
    proof = signSessionOp(
      this.signer,
      sessionId,
      this.peer,
      { op: 'report', epoch: p.epoch, issue: p.issue },
      { server: this.server.id, since: room.since },
    );
    return this.send(method, { ...p, proof }, timeoutMs);
  }

  close() {
    if (this.closed) return;
    this.ws.close(1000, 'bye');
    this.onClose(1000, 'closed by client');
  }

  private onMessage(data: unknown) {
    let frame: ServerFrame;
    try {
      const outer = JSON.parse(String(data)) as { t: string; n: number; c: string };
      if (outer.t !== 'x') return;
      const inner = this.channel.open(outer) as ServerFrame | undefined;
      if (!inner) return this.close();
      frame = inner;
    } catch {
      return;
    }
    if (frame.t === 'res') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.err) p.reject(new RpcCallError(frame.err.code, frame.err.message));
      else p.resolve(frame.ok);
    } else if (frame.t === 'ev') {
      // Out of a room by the server's doing: nothing we signed there stands.
      if (frame.ev === 'session_closed')
        this.forget((frame.d as ServerEvents['session_closed']).sessionId);
      this.emit(frame.ev, frame.d as never);
    }
  }

  private onClose(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcCallError('unavailable', 'connection closed'));
    }
    this.pending.clear();
    this.emit('close', { code, reason });
  }
}
