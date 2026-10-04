import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Coordinator } from '../src/coordinator';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function start(extra: { stunAltPort?: number | null } = {}) {
  const c = await new Coordinator({
    name: 'stun',
    host: '127.0.0.1',
    port: 0,
    stunPort: 0,
    storage: 'memory',
    logLevel: 'error',
    ...extra,
  }).start();
  cleanup.push(() => c.stop());
  return c;
}

/** Sends a STUN binding request from one local socket; resolves with the mapped port. */
function mappedPort(socket: ReturnType<typeof createSocket>, port: number): Promise<number> {
  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0);
  req.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(req, 8);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no STUN answer on ${port}`)), 2000);
    socket.once('message', (msg) => {
      clearTimeout(timer);
      // XOR-MAPPED-ADDRESS is the only attribute: port at offset 26.
      resolve(msg.readUInt16BE(26) ^ 0x2112);
    });
    socket.send(req, port, '127.0.0.1');
  });
}

describe('built-in STUN', () => {
  it('answers on two ports so apps can detect their NAT type without third parties', async () => {
    const c = await start();
    const urls = c.stunUrls();
    expect(urls).toHaveLength(2);
    const ports = urls.map((u) => Number(u.split(':').pop()));
    expect(new Set(ports).size).toBe(2);

    const socket = createSocket('udp4');
    cleanup.push(() => socket.close());
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
    const own = socket.address().port;
    // Both ports see the same mapping: what a cone NAT (or no NAT) looks like.
    expect(await mappedPort(socket, ports[0]!)).toBe(own);
    expect(await mappedPort(socket, ports[1]!)).toBe(own);
  });

  it('can run with a single STUN port', async () => {
    const c = await start({ stunAltPort: null });
    expect(c.stunUrls()).toHaveLength(1);
  });
});
