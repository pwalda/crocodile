import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { ipv6Bytes } from './turn';

/**
 * Minimal RFC 5389 STUN binding server. Coordination servers run one so the
 * ecosystem does not depend on third-party STUN; it only tells a client its
 * public address and never relays traffic.
 */
const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

export function buildBindingResponse(
  request: Buffer,
  address: string,
  port: number,
): Buffer | null {
  if (request.length < 20) return null;
  if (request.readUInt16BE(0) !== BINDING_REQUEST || request.readUInt32BE(4) !== MAGIC) return null;
  const txId = request.subarray(8, 20);
  const v4 = isIPv4(address);
  const addrLen = v4 ? 4 : 16;
  const attr = Buffer.alloc(4 + 4 + addrLen);
  attr.writeUInt16BE(XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(4 + addrLen, 2);
  attr.writeUInt8(0, 4);
  attr.writeUInt8(v4 ? 0x01 : 0x02, 5);
  attr.writeUInt16BE(port ^ (MAGIC >>> 16), 6);
  const raw = v4 ? Buffer.from(address.split('.').map(Number)) : ipv6Bytes(address);
  const mask = Buffer.concat([Buffer.alloc(4), txId]);
  mask.writeUInt32BE(MAGIC, 0);
  for (let i = 0; i < addrLen; i++) attr[8 + i] = raw[i]! ^ mask[i]!;
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(MAGIC, 4);
  txId.copy(header, 8);
  return Buffer.concat([header, attr]);
}

export function startStunServer(port: number, host = '0.0.0.0'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: host.includes(':') ? 'udp6' : 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => {
      const res = buildBindingResponse(msg, rinfo.address, rinfo.port);
      if (res) socket.send(res, rinfo.port, rinfo.address);
    });
    socket.once('error', reject);
    socket.bind(port, host, () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}
