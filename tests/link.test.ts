import { afterEach, describe, expect, it } from 'vitest';
import { CoordinatorLink, MemoryKeyValueStore } from '@crocodile/client-core';
import { createIdentity, randomDeviceId } from '@crocodile/crypto';
import { Directory } from '@crocodile/directory';
import { startCoordinator, waitFor } from './helpers';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** fetch, with a switch to delay or fail the /health probes. */
function controllableFetch() {
  const probes = { delayMs: 0, fail: false };
  const impl: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/health')) {
      if (probes.delayMs) await new Promise((r) => setTimeout(r, probes.delayMs));
      if (probes.fail) throw new Error('probe failed');
    }
    return fetch(input, init);
  };
  return { probes, impl };
}

async function setup() {
  const dir = await new Directory({ host: '127.0.0.1', port: 0, allowPrivateUrls: true }).start();
  cleanup.push(() => dir.stop());
  const server = await startCoordinator({ directoryUrls: [dir.url], announce: true });
  cleanup.push(() => server.stop());
  await waitFor(() => dir.listing().servers.length === 1, 5000, 'registration');
  const { probes, impl } = controllableFetch();
  const link = new CoordinatorLink({
    identity: createIdentity(),
    deviceId: randomDeviceId(),
    platform: 'bot',
    version: 'test',
    kv: new MemoryKeyValueStore(),
    directories: [dir.url],
    fetchImpl: impl,
  });
  cleanup.push(() => link.stop());
  link.start();
  await waitFor(() => link.status === 'connected', 5000, 'connected');
  return { link, probes, server };
}

describe('coordinator link latency', () => {
  it('drops a measurement that finishes after the link was stopped', async () => {
    const { link, probes } = await setup();
    const seen: number[] = [];
    link.on('latency', ({ rttMs }) => seen.push(rttMs));
    probes.delayMs = 200;
    const measuring = link.measureLatency();
    link.stop();
    await measuring;
    expect(seen).toEqual([]);
  });

  it('keeps the last value everywhere when one refresh cannot reach the connected server', async () => {
    const { link, probes, server } = await setup();
    const before = link.server!.rttMs;
    probes.fail = true;
    await link.refreshServers();
    expect(link.server!.rttMs).toBe(before);
    expect(link.listed.find((s) => s.info.id === server.info.id)!.rttMs).toBe(before);
  });
});

describe('coordinator link lifecycle', () => {
  it('a connection that completes after stop() is closed, not kept', async () => {
    const server = await startCoordinator();
    cleanup.push(() => server.stop());
    // The server's hello reaches the app slowly, so stop() comes mid-handshake.
    class SlowSocket extends WebSocket {
      override set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        super.onmessage = (ev: MessageEvent) => void setTimeout(() => fn?.(ev), 300);
      }
      override get onmessage() {
        return super.onmessage;
      }
    }
    const link = new CoordinatorLink({
      identity: createIdentity(),
      deviceId: randomDeviceId(),
      platform: 'bot',
      version: 'test',
      kv: new MemoryKeyValueStore(),
      directories: [],
      preferredServers: [server.url],
      WebSocketImpl: SlowSocket,
    });
    cleanup.push(() => link.stop());
    link.start();
    await waitFor(() => link.status === 'connecting', 5000, 'connecting');
    link.stop();
    await new Promise((r) => setTimeout(r, 2000));
    expect(link.status).toBe('idle');
    expect(link.connection).toBeUndefined();
    expect(server.presence.localCount).toBe(0);
  });
});
