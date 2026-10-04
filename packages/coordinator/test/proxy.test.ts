import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../src/coordinator';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Opens a client socket; resolves with the close code, or 0 if it stays open. */
function attempt(url: string, forwardedFor: string): Promise<number> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/v1/client`, {
    headers: { 'x-forwarded-for': forwardedFor },
  });
  cleanup.push(() => ws.terminate());
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => resolve(-1));
    // Admission is decided as soon as the socket opens; give it a moment.
    ws.once('open', () => setTimeout(() => resolve(0), 300));
  });
}

describe('behind a reverse proxy', () => {
  it('uses the address the proxy saw, not one the client wrote', async () => {
    const c = await new Coordinator({
      name: 'proxied',
      host: '127.0.0.1',
      port: 0,
      stunPort: null,
      storage: 'memory',
      trustProxy: true,
      maxConnectionsPerIp: 1,
      logLevel: 'error',
    }).start();
    cleanup.push(() => c.stop());

    // A proxy that appends: "<whatever the client sent>, <real client>".
    // Different fake entries from the same real client must still share one
    // per-address budget.
    expect(await attempt(c.url, '203.0.113.1, 198.51.100.7')).toBe(0);
    expect(await attempt(c.url, '203.0.113.2, 198.51.100.7')).toBe(1008);
  });
});
