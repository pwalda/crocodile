import { isIP } from 'node:net';
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
  /** Whether it has filled up again, so that a new one would answer the same. */
  isFull(now = Date.now()): boolean {
    return this.tokens + ((now - this.last) / 1000) * this.rate >= this.burst;
  }
}

/**
 * One bucket for each key (an address, say), which outlives the connection that used it. A bucket
 * that has filled up again is forgotten, so the table holds only keys that spent something lately;
 * if even those fill it, nothing more is allowed until some are full again.
 */
export class KeyedLimiter {
  private readonly buckets = new Map<string, RateLimiter>();
  private sweptAt = 0;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly maxKeys = 100_000,
  ) {}
  take(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep(now);
        if (this.buckets.size >= this.maxKeys) return false;
      } else if (now - this.sweptAt > 60_000) this.sweep(now);
      this.buckets.set(key, (bucket = new RateLimiter(this.rate, this.burst)));
    }
    return bucket.take();
  }
  private sweep(now: number) {
    this.sweptAt = now;
    for (const [key, bucket] of this.buckets) if (bucket.isFull(now)) this.buckets.delete(key);
  }
  get size() {
    return this.buckets.size;
  }
}

/**
 * What to count an address as: itself, or for IPv6 its /64, which one machine has all of and can
 * turn through at will. An IPv4 address in IPv6 form is the IPv4 address.
 */
export function addressKey(ip: string | undefined): string {
  if (!ip) return '';
  const bare = ip.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped) return mapped[1]!;
  if (isIP(bare) !== 6) return bare;
  const [head = '', tail] = bare.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? first
      : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last];
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':');
}

export function sendJson(ws: WebSocket, value: unknown): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(value));
  return true;
}

/** An address as other servers take it: no stray space, no slash at the end, and its http or
 * https scheme in lower case. */
export const cleanUrl = (url: string) =>
  url
    .trim()
    .replace(/\/$/, '')
    .replace(/^https?(?=:\/\/)/i, (scheme) => scheme.toLowerCase());

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

/**
 * Bytes of JSON one frame between servers may carry. Sealed (padded, then
 * base64) it stays under LIMITS.wsMessageMaxBytes, which the receiving side
 * enforces by closing the link.
 */
export const FRAME_BUDGET = 512 * 1024;

export const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/**
 * Splits items into runs whose JSON fits in `budget` bytes and `max` items.
 * A single item larger than the budget goes alone (records are smaller).
 */
export function chunkByBytes<T>(items: T[], budget = FRAME_BUDGET, max = Infinity): T[][] {
  return [...runsByBytes(items, budget, max)];
}

/** `chunkByBytes`, one run at a time: the first costs no more than it takes to fill it. */
function* runsByBytes<T>(items: T[], budget: number, max = Infinity): Generator<T[]> {
  let run: T[] = [];
  // A run's JSON: its items, a comma or bracket after each, and "[" first.
  let size = 1;
  for (const item of items) {
    const n = jsonBytes(item) + 1;
    if (run.length && (size + n > budget || run.length >= max)) {
      yield run;
      run = [];
      size = 1;
    }
    run.push(item);
    size += n;
  }
  if (run.length) yield run;
}

/** The longest leading run of items that fits in `budget` bytes. */
export function withinBytes<T>(items: T[], budget = FRAME_BUDGET): T[] {
  return runsByBytes(items, budget).next().value ?? [];
}

/** What fits in one frame, and `more` when something was left out. */
export function cutToFrame<T>(items: T[]): { records: T[]; more?: true } {
  const records = withinBytes(items);
  return records.length < items.length ? { records, more: true } : { records };
}

/**
 * A number from a command-line option or environment variable: the fallback
 * when unset, an error for anything that isn't a number in range (a typo
 * would otherwise become NaN, and NaN comparisons are always false).
 */
export function numberOption(
  raw: string | undefined,
  name: string,
  fallback: number,
  range: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  const { min = -Infinity, max = Infinity, integer = true } = range;
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    const bounds = [
      min > -Infinity ? `at least ${min}` : '',
      max < Infinity ? `at most ${max}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    throw new Error(
      `${name} must be ${integer ? 'a whole number' : 'a number'}${bounds ? ` ${bounds}` : ''}, not "${raw}"`,
    );
  }
  return n;
}
