import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RTCPeerConnection } from 'werift';
import { createIdentity } from '@crocodile/crypto';
import { parsePortRange, TurnServer } from '../packages/coordinator/src/turn';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function startTurn(relayPorts?: { min: number; max: number }) {
  const turn = await new TurnServer({
    port: 0,
    host: '127.0.0.1',
    relayIp: '203.0.113.7',
    secret: randomBytes(32),
    ...(relayPorts ? { relayPorts } : {}),
  }).start();
  cleanup.push(() => turn.stop());
  return turn;
}

/** Allocates through werift's TURN client; returns the relayed ports it was given. */
async function relayedPorts(turn: TurnServer, waitMs = 3000) {
  const { username, credential } = turn.credentials(createIdentity().userId, Date.now() + 60_000);
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: `turn:127.0.0.1:${turn.port}`, username, credential }],
    iceTransportPolicy: 'relay',
  });
  cleanup.push(() => pc.close());
  const ports: number[] = [];
  pc.onIceCandidate.subscribe((c) => {
    const parts = c?.candidate?.split(' ') ?? [];
    if (parts[7] === 'relay' && parts[4] === '203.0.113.7') ports.push(Number(parts[5]));
  });
  pc.createDataChannel('probe');
  await pc.setLocalDescription(await pc.createOffer());
  const start = Date.now();
  while (ports.length === 0 && Date.now() - start < waitMs)
    await new Promise((r) => setTimeout(r, 50));
  return ports;
}

describe('TURN relay ports', () => {
  it('gives each allocation a port from the configured range, so it can be published', async () => {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const turn = await startTurn({ min: base, max: base + 1 });
    const a = await relayedPorts(turn);
    const b = await relayedPorts(turn);
    expect([...a, ...b].sort()).toEqual([base, base + 1]);
    // The range is used up: no further allocation, rather than one on another port.
    expect(await relayedPorts(turn, 1500)).toEqual([]);
    expect(turn.allocationCount()).toBe(2);
  });

  it('reads a port range', () => {
    expect(parsePortRange('49160-49259')).toEqual({ min: 49160, max: 49259 });
    expect(parsePortRange(' 50000 - 50000 ')).toEqual({ min: 50000, max: 50000 });
    for (const bad of ['49160', '50000-49000', '80-90', '60000-70000', 'a-b'])
      expect(() => parsePortRange(bad)).toThrow(/relay ports/);
  });
});
