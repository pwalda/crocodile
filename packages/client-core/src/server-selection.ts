import { DIRECTORY_PATHS, type DirectoryListing, type ServerInfo } from '@crocodile/protocol';
import type { KeyValueStore } from './platform';

export interface RankedServer {
  info: ServerInfo;
  rttMs: number;
  /** 0..1, share of capacity in use as reported to the directory. */
  load: number;
}

const CACHE_KEY = 'directory-cache';

/**
 * Fetches coordination servers from every configured directory, merges the
 * listings and falls back to the last cached listing when all directories
 * are unreachable, so the app keeps working if the directory goes down.
 */
export async function fetchServerList(
  directories: string[],
  kv: KeyValueStore,
  fetchImpl: typeof fetch = fetch,
): Promise<{ servers: ServerInfo[]; loads: Map<string, number>; fromCache: boolean }> {
  const merged = new Map<string, ServerInfo>();
  const loads = new Map<string, number>();
  let any = false;
  await Promise.all(
    directories.map(async (base) => {
      try {
        const res = await fetchImpl(base.replace(/\/$/, '') + DIRECTORY_PATHS.list, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const listing = (await res.json()) as DirectoryListing;
        any = true;
        for (const e of listing.servers) {
          merged.set(e.server.id, e.server);
          loads.set(e.server.id, e.load.capacity ? e.load.users / e.load.capacity : 0);
        }
      } catch {
        /* try the others */
      }
    }),
  );
  if (any) {
    await kv.set(CACHE_KEY, { servers: [...merged.values()], at: Date.now() });
    return { servers: [...merged.values()], loads, fromCache: false };
  }
  const cached = await kv.get<{ servers: ServerInfo[] }>(CACHE_KEY);
  return { servers: cached?.servers ?? [], loads, fromCache: true };
}

/** Median HTTP round-trip to a server's /health, or Infinity if unreachable. */
export async function probeLatency(url: string, fetchImpl: typeof fetch = fetch, samples = 3): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    try {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return Number.POSITIVE_INFINITY;
      await res.arrayBuffer();
      times.push(performance.now() - start);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/**
 * Ranks servers by latency, nudged away from nearly-full servers. The first
 * entry is the one to use, the second is the standby.
 */
export async function rankServers(
  servers: ServerInfo[],
  loads: Map<string, number>,
  fetchImpl: typeof fetch = fetch,
): Promise<RankedServer[]> {
  const probed = await Promise.all(
    servers.map(async (info) => ({ info, rttMs: await probeLatency(info.url, fetchImpl), load: loads.get(info.id) ?? 0 })),
  );
  const score = (s: RankedServer) => s.rttMs * (s.load > 0.9 ? 3 : s.load > 0.75 ? 1.5 : 1);
  return probed.filter((s) => Number.isFinite(s.rttMs)).sort((a, b) => score(a) - score(b));
}
