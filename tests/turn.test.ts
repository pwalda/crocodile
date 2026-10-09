import { createSocket, type Socket } from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdentity } from '@crocodile/crypto';
import {
  encodeStun,
  parsePortRange,
  parseStun,
  parseXorAddress,
  TurnServer,
} from '../packages/coordinator/src/turn';

const ALLOCATE = 0x003;
const REQUEST = 0;
const ERROR = 3;
const ATTR = {
  username: 0x0006,
  errorCode: 0x0009,
  realm: 0x0014,
  nonce: 0x0015,
  xorRelayedAddress: 0x0016,
  requestedTransport: 0x0019,
};

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
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

function exchange(socket: Socket, port: number, msg: Buffer) {
  return new Promise<NonNullable<ReturnType<typeof parseStun>>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), 2000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(parseStun(data)!);
    });
    socket.send(msg, port, '127.0.0.1');
  });
}

const attr = (m: { attrs: { type: number; value: Buffer }[] }, type: number) =>
  m.attrs.find((a) => a.type === type)?.value;

/** Allocates through the long-term credential handshake; returns the relayed port. */
async function allocate(turn: TurnServer, userId: string) {
  const { username, credential } = turn.credentials(userId, Date.now() + 60_000);
  const socket = createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', () => r()));
  cleanup.push(() => socket.close());
  const transport = { type: ATTR.requestedTransport, value: Buffer.from([17, 0, 0, 0]) };
  const challenge = await exchange(
    socket,
    turn.port,
    encodeStun(ALLOCATE, REQUEST, randomBytes(12), [transport]),
  );
  const realm = attr(challenge, ATTR.realm)!;
  const nonce = attr(challenge, ATTR.nonce)!;
  const key = createHash('md5').update(`${username}:${realm}:${credential}`).digest();
  const txId = randomBytes(12);
  const res = await exchange(
    socket,
    turn.port,
    encodeStun(
      ALLOCATE,
      REQUEST,
      txId,
      [
        transport,
        { type: ATTR.username, value: Buffer.from(username) },
        { type: ATTR.realm, value: realm },
        { type: ATTR.nonce, value: nonce },
      ],
      key,
    ),
  );
  if (res.cls === ERROR) {
    const code = attr(res, ATTR.errorCode)!;
    return { error: code.readUInt8(2) * 100 + code.readUInt8(3) };
  }
  const relayed = parseXorAddress(attr(res, ATTR.xorRelayedAddress)!, txId)!;
  return { relayed };
}

describe('TURN relay ports', () => {
  it('gives each allocation a port from the configured range, so it can be published', async () => {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const turn = await startTurn({ min: base, max: base + 1 });
    const a = await allocate(turn, createIdentity().userId);
    const b = await allocate(turn, createIdentity().userId);
    expect(a.relayed!.address).toBe('203.0.113.7');
    expect([a.relayed!.port, b.relayed!.port].sort()).toEqual([base, base + 1]);
    // The range is used up: the next one is refused rather than given another port.
    const c = await allocate(turn, createIdentity().userId);
    expect(c.error).toBe(508);
  });

  it('reads a port range', () => {
    expect(parsePortRange('49160-49259')).toEqual({ min: 49160, max: 49259 });
    expect(parsePortRange(' 50000 - 50000 ')).toEqual({ min: 50000, max: 50000 });
    for (const bad of ['49160', '50000-49000', '80-90', '60000-70000', 'a-b'])
      expect(() => parsePortRange(bad)).toThrow(/relay ports/);
  });
});
