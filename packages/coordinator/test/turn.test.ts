import { afterEach, describe, expect, it } from 'vitest';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { randomBytes } from 'node:crypto';
import { TurnServer } from '../src/turn';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function waitFor<T>(fn: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function connect(a: RTCPeerConnection, b: RTCPeerConnection) {
  a.onIceCandidate.subscribe((c) => c && b.addIceCandidate(c).catch(() => {}));
  b.onIceCandidate.subscribe((c) => c && a.addIceCandidate(c).catch(() => {}));
  const dc = a.createDataChannel('x');
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  return dc;
}

describe('TURN relay', () => {
  it('relays a WebRTC data channel for a relay-only peer and enforces grants and quotas', async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
      limits: { maxUsers: 1 },
    }).start();
    cleanup.push(() => turn.stop());
    const creds = turn.credentials('aaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now() + 60_000);

    const relayed = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: creds.username,
          credential: creds.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    const direct = new RTCPeerConnection({
      iceServers: [{ urls: `stun:127.0.0.1:${turn.port}` }],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    });
    cleanup.push(
      () => relayed.close(),
      () => direct.close(),
    );
    const received: string[] = [];
    direct.onDataChannel.subscribe((ch: RTCDataChannel) =>
      ch.onMessage.subscribe((m) => received.push(m.toString())),
    );
    const dc = await connect(relayed, direct);
    await waitFor(() => dc.readyState === 'open');
    dc.send('through the relay');
    await waitFor(() => received.includes('through the relay'));
    expect(turn.allocationCount()).toBe(1);
    expect(turn.activeUsers()).toEqual(new Set(['aaaaaaaaaaaaaaaaaaaaaaaaaa']));

    // A second user is refused while the one-user quota is taken.
    const other = turn.credentials('bbbbbbbbbbbbbbbbbbbbbbbbbb', Date.now() + 60_000);
    const refused = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: other.username,
          credential: other.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    cleanup.push(() => refused.close());
    refused.createDataChannel('y');
    const gathered: string[] = [];
    refused.onIceCandidate.subscribe((c) => c && gathered.push(c.candidate));
    await refused.setLocalDescription(await refused.createOffer());
    await new Promise((r) => setTimeout(r, 500));
    expect(gathered.filter((c) => c.includes('relay'))).toHaveLength(0);

    // Expired credentials are rejected outright.
    const expired = turn.credentials('cccccccccccccccccccccccccc', Date.now() - 1000);
    const late = new RTCPeerConnection({
      iceServers: [
        {
          urls: `turn:127.0.0.1:${turn.port}`,
          username: expired.username,
          credential: expired.credential,
        },
      ],
      iceTransportPolicy: 'relay',
    });
    cleanup.push(() => late.close());
    late.createDataChannel('z');
    const lateCands: string[] = [];
    late.onIceCandidate.subscribe((c) => c && lateCands.push(c.candidate));
    await late.setLocalDescription(await late.createOffer());
    await new Promise((r) => setTimeout(r, 500));
    expect(lateCands.filter((c) => c.includes('relay'))).toHaveLength(0);

    turn.dropUser('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(turn.allocationCount()).toBe(0);
  });
});
