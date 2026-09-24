import { sign, verifyPayload, type Identity } from '@crocodile/crypto';
import {
  SIG_DOMAIN,
  type Platform,
  type RpcError,
  type RpcMethod,
  type RpcMethods,
  type RpcParamsOf,
  type ServerEvents,
  type ServerFrame,
  type ServerHello,
  type ServerInfo,
} from '@crocodile/protocol';
import { Emitter } from './emitter';

export class RpcCallError extends Error {
  constructor(
    readonly code: RpcError['code'],
    message: string,
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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    readonly server: ServerInfo,
    readonly stun: string[],
    readonly userId: string,
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
      const fail = (err: Error) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`timed out connecting to ${opts.url}`)), opts.timeoutMs ?? 10_000);
      ws.onerror = () => fail(new Error(`cannot reach ${opts.url}`));
      ws.onclose = (ev) => fail(new Error(`connection closed: ${ev.reason || ev.code}`));
      ws.onmessage = (ev) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(ev.data)) as ServerFrame;
        } catch {
          return fail(new Error('invalid frame from server'));
        }
        if (frame.t === 'hello') {
          hello = frame;
          const ok = verifyPayload(
            frame.server.key,
            SIG_DOMAIN.serverHello,
            { challenge: frame.challenge, server: frame.server.id, time: frame.time },
            frame.sig,
          );
          if (!ok) return fail(new Error('server failed to prove its identity'));
          if (opts.expectedServerKey && opts.expectedServerKey !== frame.server.key) {
            return fail(new Error('server key does not match the directory listing'));
          }
          ws.send(
            JSON.stringify({
              t: 'auth',
              key: opts.identity.publicKey,
              sig: sign(opts.identity, SIG_DOMAIN.auth, { challenge: frame.challenge, server: frame.server.id }),
              client: { platform: opts.platform, version: opts.version },
            }),
          );
        } else if (frame.t === 'auth_ok' && hello) {
          clearTimeout(timer);
          ws.onerror = null;
          resolve(new CoordinatorConnection(ws, hello.server, hello.stun, frame.userId));
        } else if (frame.t === 'error') {
          fail(new Error(frame.err.message));
        }
      };
    });
  }

  get isOpen() {
    return !this.closed;
  }

  request<M extends RpcMethod>(method: M, params: RpcParamsOf<M>, timeoutMs = 15_000): Promise<RpcMethods[M]> {
    if (this.closed) return Promise.reject(new RpcCallError('unavailable', 'not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCallError('unavailable', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ t: 'req', id, m: method, p: params }));
    });
  }

  close() {
    if (this.closed) return;
    this.ws.close(1000, 'bye');
    this.onClose(1000, 'closed by client');
  }

  private onMessage(data: unknown) {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(String(data)) as ServerFrame;
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
