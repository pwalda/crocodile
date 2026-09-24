import type { WebSocket } from 'ws';

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function consoleLogger(
  name: string,
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'info',
): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
  const min = order[level];
  const out = (lvl: keyof typeof order, msg: string, extra?: Record<string, unknown>) => {
    if (order[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}`;
    const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    if (extra && Object.keys(extra).length) fn(line, JSON.stringify(extra));
    else fn(line);
  };
  return {
    debug: (m, e) => out('debug', m, e),
    info: (m, e) => out('info', m, e),
    warn: (m, e) => out('warn', m, e),
    error: (m, e) => out('error', m, e),
  };
}

/** Token bucket: `rate` tokens per second, bursting to `burst`. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export function sendJson(ws: WebSocket, value: unknown): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(value));
  return true;
}

export function toWsUrl(httpUrl: string, path: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + path;
  return u.toString();
}

export class RpcFailure extends Error {
  constructor(
    readonly code:
      | 'bad_request'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'rate_limited'
      | 'unavailable'
      | 'internal',
    message: string,
  ) {
    super(message);
  }
}
