import { afterEach, describe, expect, it } from 'vitest';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  TurnServer,
  canonicalIp,
  encodeStun,
  isForbiddenPeerAddress,
  parseStun,
  xorAddress,
} from '../src/turn';

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
      allowPrivatePeers: true,
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

  it('never relays to the host itself or its private network', async () => {
    const own = new Set(['203.0.114.9', '2a01:4f8::5'].map((a) => canonicalIp(a)!));
    for (const bad of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      '224.0.0.251',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.10',
      '::127.0.0.1',
      // Uncompressed spellings, as parsed from an IPv6 XOR-PEER-ADDRESS.
      '0:0:0:0:0:ffff:7f00:1',
      '0:0:0:0:0:0:7f00:1',
      '0:0:0:0:0:ffff:c0a8:101',
      '0:0:0:0:0:0:0:1',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '203.0.114.9',
      '::ffff:203.0.114.9',
      '2a01:4f8:0:0:0:0:0:5',
      '2A01:4F8::5',
      'not-an-ip',
    ]) {
      expect(isForbiddenPeerAddress(bad, own), bad).toBe(true);
    }
    for (const ok of [
      '8.8.8.8',
      '203.0.114.10',
      '2606:4700::1111',
      '2606:4700:0:0:0:0:0:1111',
      '::ffff:1.1.1.1',
    ]) {
      expect(isForbiddenPeerAddress(ok, own), ok).toBe(false);
    }

    // End to end: a relay-only client cannot open a path to a loopback peer.
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
    }).start();
    cleanup.push(() => turn.stop());
    const creds = turn.credentials('dddddddddddddddddddddddddd', Date.now() + 60_000);
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
    const target = new RTCPeerConnection({ iceAdditionalHostAddresses: ['127.0.0.1'] });
    cleanup.push(
      () => relayed.close(),
      () => target.close(),
    );
    const dc = await connect(relayed, target);
    await new Promise((r) => setTimeout(r, 3000));
    expect(dc.readyState).not.toBe('open');
  });

  it('refuses IPv6-encoded private peers in CreatePermission', async () => {
    const turn = await new TurnServer({
      port: 0,
      host: '127.0.0.1',
      relayIp: '127.0.0.1',
      secret: randomBytes(32),
    }).start();
    cleanup.push(() => turn.stop());
    const sock = createSocket('udp4');
    cleanup.push(() => sock.close());
    const replies: Buffer[] = [];
    sock.on('message', (b) => replies.push(b));
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    // Sends one STUN request and returns the error code of the reply (0 = success).
    const ask = async (
      method: number,
      attrs: (txId: Buffer) => { type: number; value: Buffer }[],
      key?: Buffer,
    ) => {
      const txId = randomBytes(12);
      sock.send(encodeStun(method, 0, txId, attrs(txId), key), turn.port, '127.0.0.1');
      const m = await waitFor(() =>
        replies.map(parseStun).find((r): r is NonNullable<typeof r> => !!r?.txId.equals(txId)),
      );
      const err = m.attrs.find((a) => a.type === 0x0009)?.value;
      return { m, code: err ? err[2]! * 100 + err[3]! : 0 };
    };
    const creds = turn.credentials('eeeeeeeeeeeeeeeeeeeeeeeeee', Date.now() + 60_000);
    const key = createHash('md5')
      .update(`${creds.username}:crocodile:${creds.credential}`)
      .digest();
    const transport = { type: 0x0019, value: Buffer.from([17, 0, 0, 0]) };
    const first = await ask(0x003, () => [transport]);
    expect(first.code).toBe(401);
    const auth = [
      { type: 0x0006, value: Buffer.from(creds.username) },
      { type: 0x0014, value: Buffer.from('crocodile') },
      first.m.attrs.find((a) => a.type === 0x0015)!,
    ];
    expect((await ask(0x003, () => [transport, ...auth], key)).code).toBe(0);
    const permit = async (peer: string) =>
      (
        await ask(
          0x008,
          (txId) => [{ type: 0x0012, value: xorAddress(peer, 9, txId) }, ...auth],
          key,
        )
      ).code;
    // Loopback and private IPv4 written as IPv6 (family 2) are refused…
    for (const peer of ['::ffff:127.0.0.1', '::127.0.0.1', '::ffff:192.168.1.1', '::1']) {
      expect(await permit(peer), peer).toBe(403);
    }
    // …while a public IPv6 peer is fine.
    expect(await permit('2606:4700::1111')).toBe(0);
  });
});
