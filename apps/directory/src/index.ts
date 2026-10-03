import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { keyMatchesUserId, toPublicDirectoryEntry, verifyPayload } from '@crocodile/crypto';
import {
  DIRECTORY_PATHS,
  DirectoryEntry,
  SIG_DOMAIN,
  type DirectoryListing,
} from '@crocodile/protocol';

export interface DirectoryConfig {
  host: string;
  port: number;
  /** Entries not refreshed within this window are dropped from the listing. */
  ttlMs: number;
  /** Verify a server's /health answers from its advertised URL before listing it. */
  verifyReachability: boolean;
  /** Allow loopback/private URLs (for development and LAN setups). */
  allowPrivateUrls: boolean;
  /** Persist entries across restarts. */
  statePath?: string;
  log?: (msg: string) => void;
}

export const defaultDirectoryConfig: DirectoryConfig = {
  host: '0.0.0.0',
  port: 7400,
  ttlMs: 3 * 60_000,
  verifyReachability: true,
  allowPrivateUrls: false,
};

type Stored = DirectoryEntry & { lastSeen: number; verifiedAt: number };

const MAX_SKEW_MS = 5 * 60_000;
const REVERIFY_MS = 10 * 60_000;

/**
 * The directory: a phone book of coordination servers. Servers register a
 * self-signed entry every minute; clients fetch the list and probe latency
 * themselves. It knows nothing about users, spaces or content.
 */
export class Directory {
  readonly config: DirectoryConfig;
  private entries = new Map<string, Stored>();
  private app?: FastifyInstance;
  private saveTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<DirectoryConfig> = {}) {
    this.config = { ...defaultDirectoryConfig, ...config };
    if (this.config.statePath && existsSync(this.config.statePath)) {
      const saved = JSON.parse(readFileSync(this.config.statePath, 'utf8')) as Stored[];
      for (const e of saved) this.entries.set(e.server.id, e);
    }
  }

  listing(now = Date.now()): DirectoryListing {
    // Addresses are published obfuscated, never as plain URLs/IPs.
    const servers = [...this.entries.values()]
      .filter((e) => now - e.lastSeen < this.config.ttlMs)
      .map(({ verifiedAt: _v, ...e }) => toPublicDirectoryEntry(e));
    return { servers, generatedAt: now };
  }

  async register(
    input: unknown,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const parsed = DirectoryEntry.safeParse(input);
    if (!parsed.success) return { ok: false, status: 400, error: 'malformed entry' };
    const entry = parsed.data;
    const now = Date.now();
    if (Math.abs(now - entry.signedAt) > MAX_SKEW_MS)
      return { ok: false, status: 400, error: 'stale signature; check clock' };
    if (!keyMatchesUserId(entry.server.key, entry.server.id))
      return { ok: false, status: 400, error: 'id does not match key' };
    const signed = { server: entry.server, load: entry.load, signedAt: entry.signedAt };
    if (!verifyPayload(entry.server.key, SIG_DOMAIN.directory, signed, entry.sig)) {
      return { ok: false, status: 401, error: 'bad signature' };
    }
    const url = new URL(entry.server.url);
    if (!['http:', 'https:'].includes(url.protocol))
      return { ok: false, status: 400, error: 'url must be http(s)' };
    if (!this.config.allowPrivateUrls && isPrivateHost(url.hostname)) {
      return { ok: false, status: 400, error: 'url must be publicly reachable' };
    }

    const previous = this.entries.get(entry.server.id);
    let verifiedAt = previous && previous.server.url === entry.server.url ? previous.verifiedAt : 0;
    if (this.config.verifyReachability && now - verifiedAt > REVERIFY_MS) {
      const reachable = await probe(entry.server.url, entry.server.id);
      if (!reachable)
        return { ok: false, status: 422, error: `could not reach ${entry.server.url}/health` };
      verifiedAt = now;
    }
    // One URL belongs to one server; a re-keyed server replaces its old entry.
    for (const [id, e] of this.entries)
      if (e.server.url === entry.server.url && id !== entry.server.id) this.entries.delete(id);
    if (!previous) this.config.log?.(`registered ${entry.server.name} (${entry.server.url})`);
    this.entries.set(entry.server.id, { ...entry, lastSeen: now, verifiedAt });
    return { ok: true };
  }

  async start(): Promise<this> {
    const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    this.app = app;
    app.addHook('onSend', async (_req, reply) => {
      reply.header('access-control-allow-origin', '*');
    });
    app.get(DIRECTORY_PATHS.health, async () => ({
      ok: true,
      servers: this.listing().servers.length,
      // AGPL-3.0 section 13: where to get this service's source.
      source: process.env.CROC_SOURCE_URL ?? 'https://github.com/pwalda/crocodile',
    }));
    app.get(DIRECTORY_PATHS.list, async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=15');
      return this.listing();
    });
    app.post(DIRECTORY_PATHS.register, async (req, reply) => {
      const result = await this.register(req.body);
      if (!result.ok) return reply.code(result.status).send({ error: result.error });
      return { ok: true, servers: this.listing().servers.length };
    });
    await app.listen({ host: this.config.host, port: this.config.port });
    if (this.config.statePath) {
      this.saveTimer = setInterval(() => this.save(), 30_000);
      this.saveTimer.unref?.();
    }
    return this;
  }

  get url(): string {
    const port = (this.app!.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  private save() {
    const path = this.config.statePath;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify([...this.entries.values()]));
    renameSync(`${path}.tmp`, path);
  }

  async stop() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.save();
    await this.app?.close();
  }
}

async function probe(baseUrl: string, expectedId: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { id?: string };
    return body.id === expectedId;
  } catch {
    return false;
  }
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}
