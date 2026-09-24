import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * A small TURN server (RFC 5766 over UDP) plus STUN binding responder.
 *
 * Only used by clients whose users opted in to "relay through a coordination
 * server" when no direct path exists. Everything it forwards is already
 * DTLS-SRTP *and* end-to-end encrypted, so it relays ciphertext only.
 *
 * Credentials follow the TURN REST API convention: the coordinator hands out
 * `username = "<expiry>:<userId>"`, `password = HMAC-SHA1(secret, username)`,
 * so grants expire on their own (at most one hour) and the server can refuse
 * refreshes past expiry. A cap on concurrent relayed users and a per-
 * allocation bandwidth budget keep the volunteer's server safe.
 */

const MAGIC = 0x2112a442;
const REALM = 'crocodile';

const METHOD = {
  binding: 0x001,
  allocate: 0x003,
  refresh: 0x004,
  send: 0x006,
  data: 0x007,
  createPermission: 0x008,
  channelBind: 0x009,
} as const;
const CLASS = { request: 0, indication: 1, success: 2, error: 3 } as const;
const ATTR = {
  mappedAddress: 0x0001,
  username: 0x0006,
  messageIntegrity: 0x0008,
  errorCode: 0x0009,
  unknownAttributes: 0x000a,
  channelNumber: 0x000c,
  lifetime: 0x000d,
  xorPeerAddress: 0x0012,
  data: 0x0013,
  realm: 0x0014,
  nonce: 0x0015,
  xorRelayedAddress: 0x0016,
  requestedTransport: 0x0019,
  dontFragment: 0x001a,
  xorMappedAddress: 0x0020,
  software: 0x8022,
  fingerprint: 0x8028,
} as const;

export interface TurnLimits {
  /** Max distinct users with a live grant at once. */
  maxUsers: number;
  /** Max allocations (≈ peer connections) per user. */
  maxAllocationsPerUser: number;
  /** Bytes per second each allocation may relay (both directions). */
  bytesPerSecond: number;
  /** Longest a single grant may last. */
  maxGrantMs: number;
}

export const defaultTurnLimits: TurnLimits = {
  maxUsers: 25,
  maxAllocationsPerUser: 4,
  bytesPerSecond: 96 * 1024,
  maxGrantMs: 60 * 60_000,
};

interface Attr {
  type: number;
  value: Buffer;
}

interface Msg {
  method: number;
  cls: number;
  txId: Buffer;
  attrs: Attr[];
  raw: Buffer;
}

function msgType(method: number, cls: number) {
  return (
    (method & 0x000f) |
    ((method & 0x0070) << 1) |
    ((method & 0x0f80) << 2) |
    ((cls & 1) << 4) |
    ((cls & 2) << 7)
  );
}

export function parseStun(buf: Buffer): Msg | null {
  if (buf.length < 20 || (buf[0]! & 0xc0) !== 0) return null;
  if (buf.readUInt32BE(4) !== MAGIC) return null;
  const len = buf.readUInt16BE(2);
  if (len + 20 > buf.length || len % 4 !== 0) return null;
  const t = buf.readUInt16BE(0);
  const method = (t & 0x000f) | ((t & 0x00e0) >> 1) | ((t & 0x3e00) >> 2);
  const cls = ((t & 0x0010) >> 4) | ((t & 0x0100) >> 7);
  const attrs: Attr[] = [];
  let o = 20;
  while (o + 4 <= 20 + len) {
    const type = buf.readUInt16BE(o);
    const alen = buf.readUInt16BE(o + 2);
    if (o + 4 + alen > 20 + len) return null;
    attrs.push({ type, value: buf.subarray(o + 4, o + 4 + alen) });
    o += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return { method, cls, txId: buf.subarray(8, 20), attrs, raw: buf.subarray(0, 20 + len) };
}

const attrOf = (m: Msg, type: number) => m.attrs.find((a) => a.type === type)?.value;

function encodeAttr(type: number, value: Buffer): Buffer {
  const pad = (4 - (value.length % 4)) % 4;
  const out = Buffer.alloc(4 + value.length + pad);
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(value.length, 2);
  value.copy(out, 4);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeStun(
  method: number,
  cls: number,
  txId: Buffer,
  attrs: Attr[],
  integrityKey?: Buffer,
): Buffer {
  let body = Buffer.concat(attrs.map((a) => encodeAttr(a.type, a.value)));
  const header = (bodyLen: number) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(msgType(method, cls), 0);
    h.writeUInt16BE(bodyLen, 2);
    h.writeUInt32BE(MAGIC, 4);
    txId.copy(h, 8);
    return h;
  };
  if (integrityKey) {
    const hmac = createHmac('sha1', integrityKey)
      .update(Buffer.concat([header(body.length + 24), body]))
      .digest();
    body = Buffer.concat([body, encodeAttr(ATTR.messageIntegrity, hmac)]);
  }
  const withFp = Buffer.concat([header(body.length + 8), body]);
  const fp = Buffer.alloc(4);
  fp.writeUInt32BE((crc32(withFp) ^ 0x5354554e) >>> 0);
  return Buffer.concat([withFp, encodeAttr(ATTR.fingerprint, fp)]);
}

function verifyIntegrity(m: Msg, key: Buffer): boolean {
  // Find MESSAGE-INTEGRITY's offset in the raw message.
  let o = 20;
  while (o + 4 <= m.raw.length) {
    const type = m.raw.readUInt16BE(o);
    const alen = m.raw.readUInt16BE(o + 2);
    if (type === ATTR.messageIntegrity) {
      if (alen !== 20) return false;
      const prefix = Buffer.from(m.raw.subarray(0, o));
      prefix.writeUInt16BE(o - 20 + 24, 2);
      const expected = createHmac('sha1', key).update(prefix).digest();
      return timingSafeEqual(expected, m.raw.subarray(o + 4, o + 24));
    }
    o += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return false;
}

export function xorAddress(address: string, port: number, txId: Buffer): Buffer {
  const v4 = isIPv4(address);
  const raw = v4 ? Buffer.from(address.split('.').map(Number)) : ipv6Bytes(address);
  const out = Buffer.alloc(4 + raw.length);
  out.writeUInt8(0, 0);
  out.writeUInt8(v4 ? 1 : 2, 1);
  out.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const mask = Buffer.concat([Buffer.alloc(4), txId]);
  mask.writeUInt32BE(MAGIC, 0);
  for (let i = 0; i < raw.length; i++) out[4 + i] = raw[i]! ^ mask[i]!;
  return out;
}

export function parseXorAddress(
  value: Buffer,
  txId: Buffer,
): { address: string; port: number } | null {
  if (value.length < 8) return null;
  const family = value[1];
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  const mask = Buffer.concat([Buffer.alloc(4), txId]);
  mask.writeUInt32BE(MAGIC, 0);
  if (family === 1) {
    const b = [0, 1, 2, 3].map((i) => value[4 + i]! ^ mask[i]!);
    return { address: b.join('.'), port };
  }
  if (family === 2 && value.length >= 20) {
    const b = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) b[i] = value[4 + i]! ^ mask[i]!;
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
    return { address: groups.join(':'), port };
  }
  return null;
}

function ipv6Bytes(address: string): Buffer {
  const clean = address.split('%')[0]!;
  const mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped)
    return Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]),
      Buffer.from(mapped[1]!.split('.').map(Number)),
    ]);
  const [head, tail = ''] = clean.split('::') as [string, string?];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const buf = Buffer.alloc(16);
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return buf;
}

function errorAttr(code: number, reason: string): Attr {
  const r = Buffer.from(reason, 'utf8');
  const v = Buffer.alloc(4 + r.length);
  v.writeUInt8(Math.floor(code / 100), 2);
  v.writeUInt8(code % 100, 3);
  r.copy(v, 4);
  return { type: ATTR.errorCode, value: v };
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

interface Allocation {
  tuple: string;
  client: { address: string; port: number };
  /** Listening socket the client talks to; replies must come from it. */
  via: Socket;
  userId: string;
  integrityKey: Buffer;
  grantExpiresAt: number;
  expiresAt: number;
  socket: Socket;
  relayPort: number;
  permissions: Map<string, number>;
  channels: Map<number, { address: string; port: number }>;
  channelByPeer: Map<string, number>;
  tokens: number;
  lastRefill: number;
  bytesRelayed: number;
}

export interface TurnServerOptions {
  port: number;
  host?: string;
  /** Public IP advertised in XOR-RELAYED-ADDRESS. */
  relayIp: string;
  /** Shared secret for REST-API style credentials. */
  secret: Buffer;
  limits?: Partial<TurnLimits>;
  /**
   * Allow relaying to loopback/private/link-local addresses. Off by default:
   * otherwise a relay user could reach services on the server's own machine
   * or home network. Only for LAN-only deployments and tests.
   */
  allowPrivatePeers?: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Peer addresses a public relay must never send to: "this host", loopback,
 * private and carrier-grade NAT ranges, link-local, multicast, reserved and
 * documentation ranges (IPv4, IPv6 and IPv4-mapped IPv6), plus the server's
 * own addresses. Same class of issue as coturn's CVE-2020-26262.
 */
const FORBIDDEN_PEERS = (() => {
  const b = new BlockList();
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    b.addSubnet(net, bits, 'ipv4');
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001::', 32],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    b.addSubnet(net, bits, 'ipv6');
  return b;
})();

export function isForbiddenPeerAddress(address: string, own: ReadonlySet<string> = new Set()) {
  const addr = address
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1]! : isIPv4(addr) ? addr : null;
  if (own.has(addr) || (v4 && own.has(v4))) return true;
  if (v4) return FORBIDDEN_PEERS.check(v4, 'ipv4');
  if (isIP(addr) !== 6) return true;
  // Other IPv4-in-IPv6 forms (::a.b.c.d, ::ffff:hex) are refused outright.
  if (/^::(ffff:)?[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(addr) || addr.includes('.')) return true;
  return FORBIDDEN_PEERS.check(addr, 'ipv6');
}

export class TurnServer {
  readonly limits: TurnLimits;
  /** One socket per local address, so replies leave from the address the client used. */
  private sockets: Socket[] = [];
  private allocations = new Map<string, Allocation>();
  private sweep?: ReturnType<typeof setInterval>;
  /** This machine's own addresses (never valid relay peers). */
  private own = new Set<string>();
  port = 0;

  constructor(private readonly opts: TurnServerOptions) {
    this.limits = { ...defaultTurnLimits, ...opts.limits };
  }

  async start(): Promise<this> {
    const host = this.opts.host ?? '0.0.0.0';
    const wildcard = host === '0.0.0.0' || host === '::';
    const addresses = wildcard ? localAddresses(host === '::') : [host];
    let port = this.opts.port;
    for (const address of addresses) {
      try {
        const socket = await bindUdp(address, port);
        port = socket.address().port;
        socket.on('message', (msg, rinfo) => this.onClientPacket(socket, msg, rinfo));
        this.sockets.push(socket);
      } catch (err) {
        if (this.sockets.length === 0 && address === addresses.at(-1)) throw err;
      }
    }
    if (this.sockets.length === 0) throw new Error('could not bind any UDP socket');
    this.own = new Set([...localAddresses(true), this.opts.relayIp].map((a) => a.toLowerCase()));
    this.port = port;
    this.sweep = setInterval(() => this.expire(), 2000);
    this.sweep.unref?.();
    return this;
  }

  /** Issue REST-API credentials valid until `expiresAt`. */
  credentials(userId: string, expiresAt: number) {
    const username = `${Math.floor(expiresAt / 1000)}:${userId}`;
    const credential = createHmac('sha1', this.opts.secret).update(username).digest('base64');
    return { username, credential };
  }

  activeUsers(): Set<string> {
    return new Set([...this.allocations.values()].map((a) => a.userId));
  }

  allocationCount() {
    return this.allocations.size;
  }

  /** Tear down everything a user has (grant released or revoked). */
  dropUser(userId: string) {
    for (const a of [...this.allocations.values()]) if (a.userId === userId) this.remove(a);
  }

  stop() {
    clearInterval(this.sweep);
    for (const a of [...this.allocations.values()]) this.remove(a);
    for (const s of this.sockets) s.close();
  }

  // ---------------------------------------------------------------------------

  private nonce(): string {
    const ts = Math.floor(Date.now() / 1000).toString(16);
    const mac = createHmac('sha1', this.opts.secret)
      .update(`nonce:${ts}`)
      .digest('hex')
      .slice(0, 16);
    return `${ts}${mac}`;
  }

  private nonceValid(nonce: string): 'ok' | 'stale' | 'bad' {
    const ts = nonce.slice(0, -16);
    const mac = createHmac('sha1', this.opts.secret)
      .update(`nonce:${ts}`)
      .digest('hex')
      .slice(0, 16);
    if (mac !== nonce.slice(-16)) return 'bad';
    return Date.now() / 1000 - parseInt(ts, 16) > 600 ? 'stale' : 'ok';
  }

  /** Long-term credential check; returns the key and user, or sends an error. */
  private authenticate(
    via: Socket,
    m: Msg,
    rinfo: RemoteInfo,
  ): { key: Buffer; userId: string; grantExpiresAt: number } | null {
    const username = attrOf(m, ATTR.username)?.toString('utf8');
    const nonce = attrOf(m, ATTR.nonce)?.toString('utf8');
    const challenge = (code: number, reason: string) =>
      this.reply(via, m, rinfo, CLASS.error, [
        errorAttr(code, reason),
        { type: ATTR.realm, value: Buffer.from(REALM) },
        { type: ATTR.nonce, value: Buffer.from(this.nonce()) },
      ]);
    if (!username || !nonce || !attrOf(m, ATTR.messageIntegrity)) {
      challenge(401, 'Unauthorized');
      return null;
    }
    const nv = this.nonceValid(nonce);
    if (nv === 'stale') {
      challenge(438, 'Stale Nonce');
      return null;
    }
    const match = username.match(/^(\d+):([a-z2-7]{8,64})$/);
    const expiry = match ? Number(match[1]) * 1000 : 0;
    if (nv === 'bad' || !match || expiry < Date.now()) {
      challenge(401, 'Unauthorized');
      return null;
    }
    const password = createHmac('sha1', this.opts.secret).update(username).digest('base64');
    const key = createHash('md5').update(`${username}:${REALM}:${password}`).digest();
    if (!verifyIntegrity(m, key)) {
      challenge(401, 'Unauthorized');
      return null;
    }
    return { key, userId: match[2]!, grantExpiresAt: expiry };
  }

  private reply(via: Socket, m: Msg, rinfo: RemoteInfo, cls: number, attrs: Attr[], key?: Buffer) {
    const out = encodeStun(
      m.method,
      cls,
      m.txId,
      [...attrs, { type: ATTR.software, value: Buffer.from('crocodile') }],
      key,
    );
    via.send(out, rinfo.port, rinfo.address);
  }

  private onClientPacket(via: Socket, buf: Buffer, rinfo: RemoteInfo) {
    const tuple = `${rinfo.address}|${rinfo.port}`;
    // ChannelData: first two bits 01.
    if (buf.length >= 4 && (buf[0]! & 0xc0) === 0x40) {
      const a = this.allocations.get(tuple);
      if (!a) return;
      const channel = buf.readUInt16BE(0);
      const len = buf.readUInt16BE(2);
      const peer = a.channels.get(channel);
      if (
        !peer ||
        len + 4 > buf.length ||
        !this.hasPermission(a, peer.address) ||
        !this.spend(a, len)
      )
        return;
      a.socket.send(buf.subarray(4, 4 + len), peer.port, peer.address);
      return;
    }
    const m = parseStun(buf);
    if (!m) return;
    if (m.method === METHOD.binding && m.cls === CLASS.request) {
      this.reply(via, m, rinfo, CLASS.success, [
        { type: ATTR.xorMappedAddress, value: xorAddress(rinfo.address, rinfo.port, m.txId) },
      ]);
      return;
    }
    if (m.method === METHOD.send && m.cls === CLASS.indication) {
      const a = this.allocations.get(tuple);
      const peerAttr = attrOf(m, ATTR.xorPeerAddress);
      const data = attrOf(m, ATTR.data);
      if (!a || !peerAttr || !data) return;
      const peer = parseXorAddress(peerAttr, m.txId);
      if (!peer || !this.hasPermission(a, peer.address) || !this.spend(a, data.length)) return;
      a.socket.send(data, peer.port, peer.address);
      return;
    }
    if (m.cls !== CLASS.request) return;
    switch (m.method) {
      case METHOD.allocate:
        void this.onAllocate(via, m, rinfo, tuple);
        return;
      case METHOD.refresh:
        this.onRefresh(via, m, rinfo, tuple);
        return;
      case METHOD.createPermission:
        this.onCreatePermission(via, m, rinfo, tuple);
        return;
      case METHOD.channelBind:
        this.onChannelBind(via, m, rinfo, tuple);
        return;
    }
  }

  private async onAllocate(via: Socket, m: Msg, rinfo: RemoteInfo, tuple: string) {
    const auth = this.authenticate(via, m, rinfo);
    if (!auth) return;
    if (this.allocations.has(tuple)) {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(437, 'Allocation Mismatch')], auth.key);
      return;
    }
    const transport = attrOf(m, ATTR.requestedTransport);
    if (!transport || transport[0] !== 17) {
      this.reply(
        via,
        m,
        rinfo,
        CLASS.error,
        [errorAttr(442, 'Unsupported Transport Protocol')],
        auth.key,
      );
      return;
    }
    const users = this.activeUsers();
    const mine = [...this.allocations.values()].filter((a) => a.userId === auth.userId).length;
    if (
      (!users.has(auth.userId) && users.size >= this.limits.maxUsers) ||
      mine >= this.limits.maxAllocationsPerUser
    ) {
      this.reply(
        via,
        m,
        rinfo,
        CLASS.error,
        [errorAttr(486, 'Allocation Quota Reached')],
        auth.key,
      );
      return;
    }
    const socket = createSocket({ type: isIPv4(rinfo.address) ? 'udp4' : 'udp6' });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, () => {
          socket.off('error', reject);
          resolve();
        });
      });
    } catch {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(508, 'Insufficient Capacity')], auth.key);
      return;
    }
    socket.on('error', () => {});
    const now = Date.now();
    const lifetime = this.lifetime(m, auth.grantExpiresAt);
    const a: Allocation = {
      tuple,
      client: { address: rinfo.address, port: rinfo.port },
      via,
      userId: auth.userId,
      integrityKey: auth.key,
      grantExpiresAt: auth.grantExpiresAt,
      expiresAt: now + lifetime * 1000,
      socket,
      relayPort: socket.address().port,
      permissions: new Map(),
      channels: new Map(),
      channelByPeer: new Map(),
      tokens: this.limits.bytesPerSecond,
      lastRefill: now,
      bytesRelayed: 0,
    };
    socket.on('message', (data, from) => this.onPeerPacket(a, data, from));
    this.allocations.set(tuple, a);
    this.opts.log?.('relay allocation', { user: auth.userId, lifetime });
    this.reply(
      via,
      m,
      rinfo,
      CLASS.success,
      [
        { type: ATTR.xorRelayedAddress, value: xorAddress(this.opts.relayIp, a.relayPort, m.txId) },
        { type: ATTR.lifetime, value: u32(lifetime) },
        { type: ATTR.xorMappedAddress, value: xorAddress(rinfo.address, rinfo.port, m.txId) },
      ],
      auth.key,
    );
  }

  private lifetime(m: Msg, grantExpiresAt: number): number {
    const requested = attrOf(m, ATTR.lifetime);
    const want = requested && requested.length >= 4 ? requested.readUInt32BE(0) : 600;
    const left = Math.floor((grantExpiresAt - Date.now()) / 1000);
    return Math.max(0, Math.min(want, 3600, left));
  }

  private onRefresh(via: Socket, m: Msg, rinfo: RemoteInfo, tuple: string) {
    const auth = this.authenticate(via, m, rinfo);
    if (!auth) return;
    const a = this.allocations.get(tuple);
    if (!a) {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(437, 'Allocation Mismatch')], auth.key);
      return;
    }
    const lifetime = this.lifetime(m, auth.grantExpiresAt);
    if (lifetime === 0) this.remove(a);
    else a.expiresAt = Date.now() + lifetime * 1000;
    this.reply(
      via,
      m,
      rinfo,
      CLASS.success,
      [{ type: ATTR.lifetime, value: u32(lifetime) }],
      auth.key,
    );
  }

  private onCreatePermission(via: Socket, m: Msg, rinfo: RemoteInfo, tuple: string) {
    const auth = this.authenticate(via, m, rinfo);
    if (!auth) return;
    const a = this.allocations.get(tuple);
    if (!a) {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(437, 'Allocation Mismatch')], auth.key);
      return;
    }
    const peers = m.attrs
      .filter((x) => x.type === ATTR.xorPeerAddress)
      .map((x) => parseXorAddress(x.value, m.txId));
    if (peers.length === 0 || peers.some((p) => !p)) {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(400, 'Bad Request')], auth.key);
      return;
    }
    if (peers.some((p) => !this.peerAllowed(p!.address))) {
      this.opts.log?.('relay to forbidden peer refused', { user: a.userId });
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(403, 'Forbidden')], auth.key);
      return;
    }
    for (const p of peers) a.permissions.set(p!.address, Date.now() + 300_000);
    this.reply(via, m, rinfo, CLASS.success, [], auth.key);
  }

  private onChannelBind(via: Socket, m: Msg, rinfo: RemoteInfo, tuple: string) {
    const auth = this.authenticate(via, m, rinfo);
    if (!auth) return;
    const a = this.allocations.get(tuple);
    const ch = attrOf(m, ATTR.channelNumber);
    const peerAttr = attrOf(m, ATTR.xorPeerAddress);
    const peer = peerAttr && parseXorAddress(peerAttr, m.txId);
    const number = ch && ch.length >= 2 ? ch.readUInt16BE(0) : 0;
    if (!a || !peer || number < 0x4000 || number > 0x7ffe) {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(400, 'Bad Request')], auth.key);
      return;
    }
    if (!this.peerAllowed(peer.address)) {
      this.opts.log?.('relay to forbidden peer refused', { user: a.userId });
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(403, 'Forbidden')], auth.key);
      return;
    }
    const key = `${peer.address}|${peer.port}`;
    const existing = a.channels.get(number);
    if (
      (existing && `${existing.address}|${existing.port}` !== key) ||
      (a.channelByPeer.has(key) && a.channelByPeer.get(key) !== number)
    ) {
      this.reply(via, m, rinfo, CLASS.error, [errorAttr(400, 'Bad Request')], auth.key);
      return;
    }
    a.channels.set(number, peer);
    a.channelByPeer.set(key, number);
    a.permissions.set(peer.address, Date.now() + 300_000);
    this.reply(via, m, rinfo, CLASS.success, [], auth.key);
  }

  private onPeerPacket(a: Allocation, data: Buffer, from: RemoteInfo) {
    if (!this.hasPermission(a, from.address) || !this.spend(a, data.length)) return;
    const channel = a.channelByPeer.get(`${from.address}|${from.port}`);
    if (channel !== undefined) {
      const out = Buffer.alloc(4 + data.length + ((4 - (data.length % 4)) % 4));
      out.writeUInt16BE(channel, 0);
      out.writeUInt16BE(data.length, 2);
      data.copy(out, 4);
      a.via.send(out, a.client.port, a.client.address);
      return;
    }
    const txId = Buffer.alloc(12);
    for (let i = 0; i < 12; i++) txId[i] = Math.floor(Math.random() * 256);
    const ind = encodeStun(METHOD.data, CLASS.indication, txId, [
      { type: ATTR.xorPeerAddress, value: xorAddress(from.address, from.port, txId) },
      { type: ATTR.data, value: data },
    ]);
    a.via.send(ind, a.client.port, a.client.address);
  }

  private peerAllowed(address: string) {
    return !!this.opts.allowPrivatePeers || !isForbiddenPeerAddress(address, this.own);
  }

  private hasPermission(a: Allocation, address: string) {
    return (a.permissions.get(address) ?? 0) > Date.now();
  }

  /** Token bucket shared by both directions of an allocation. */
  private spend(a: Allocation, bytes: number): boolean {
    const now = Date.now();
    a.tokens = Math.min(
      this.limits.bytesPerSecond * 2,
      a.tokens + ((now - a.lastRefill) / 1000) * this.limits.bytesPerSecond,
    );
    a.lastRefill = now;
    if (a.tokens < bytes) return false;
    a.tokens -= bytes;
    a.bytesRelayed += bytes;
    return true;
  }

  private expire() {
    const now = Date.now();
    for (const a of [...this.allocations.values()]) {
      if (a.expiresAt < now || a.grantExpiresAt < now) this.remove(a);
    }
  }

  private remove(a: Allocation) {
    if (this.allocations.get(a.tuple) !== a) return;
    this.allocations.delete(a.tuple);
    try {
      a.socket.close();
    } catch {
      /* already closed */
    }
    this.opts.log?.('relay allocation closed', { user: a.userId, bytes: a.bytesRelayed });
  }
}

function localAddresses(ipv6: boolean): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4') out.push(a.address);
      else if (ipv6 && !a.address.startsWith('fe80')) out.push(a.address);
    }
  }
  return out.length ? out : ['0.0.0.0'];
}

function bindUdp(address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: isIPv4(address) ? 'udp4' : 'udp6' });
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}
