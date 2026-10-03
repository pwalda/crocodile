import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import {
  identityFromSeed,
  isSpaceMember,
  randomBytes,
  randomId,
  sign,
  toPublicServerInfo,
  userTag,
  type Identity,
} from '@crocodile/crypto';
import {
  fromB64u,
  LIMITS,
  PROTOCOL_VERSION,
  SIG_DOMAIN,
  toB64u,
  type DirectoryEntry,
  type LinkBox,
  type RelayGrant,
  type ServerEvents,
  type ServerInfo,
  type SignedRecord,
} from '@crocodile/protocol';
import { ClientConnection } from './client';
import { DirectoryClient } from './directory-client';
import { Mesh } from './mesh';
import { PresenceService } from './presence';
import { RecordService } from './records';
import { SessionService } from './sessions';
import { openStore, type Store } from './store';
import { TurnServer } from './turn';
import { MailboxService, defaultMailboxConfig, type MailboxConfig } from './mailbox';
import { consoleLogger, RpcFailure, type Logger } from './util';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export const COORDINATOR_VERSION = '0.1.0';

export interface CoordinatorConfig {
  /** Display name announced to the directory, e.g. "Swamp EU-1". */
  name: string;
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** URL clients and peers use to reach this server. Defaults to http://<host>:<port>. */
  publicUrl?: string;
  region?: string;
  /** Persist state here; omitted means in-memory only. */
  dataDir?: string;
  storage?: 'sqlite' | 'memory';
  /** Directory services to register with and learn peers from. */
  directoryUrls: string[];
  /** Coordination servers to link with regardless of the directory. */
  meshPeers: string[];
  /** UDP port for the built-in STUN server; null disables it. */
  stunPort: number | null;
  /** Extra STUN URLs handed to clients. */
  extraStun: string[];
  capacity: number;
  /** Register with the directory (off for private/LAN servers). */
  announce: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Fixed identity seed (base64url); otherwise generated and persisted. */
  seed?: string;
  /**
   * Opt-in relay (TURN) for users without a direct path. Runs on the STUN
   * port. Grants last at most an hour; `maxUsers` caps concurrent users.
   */
  relay: {
    enabled: boolean;
    maxUsers: number;
    publicIp?: string;
    /** Allow relaying to private/loopback addresses (LAN-only setups, tests). */
    allowPrivatePeers?: boolean;
  };
  /** Opt-in mailbox holding sealed messages for offline devices. */
  mailbox: MailboxConfig;
  /** Concurrent WebSocket connections allowed from one IP address. */
  maxConnectionsPerIp: number;
  /**
   * Take the client address from X-Forwarded-For (only behind a trusted
   * reverse proxy such as the main server's Caddy).
   */
  trustProxy: boolean;
  /**
   * Where users can get this server's source code (AGPL-3.0 section 13).
   * Operators running a modified version must point this at their changes.
   */
  sourceUrl?: string;
}

/** Source of the unmodified coordinator (AGPL-3.0). */
export const SOURCE_URL = 'https://github.com/pwalda/crocodile';

export const defaultConfig: CoordinatorConfig = {
  name: 'Crocodile coordinator',
  host: '0.0.0.0',
  port: 7443,
  directoryUrls: [],
  meshPeers: [],
  stunPort: 7443,
  extraStun: [],
  capacity: 5000,
  announce: true,
  storage: 'sqlite',
  relay: { enabled: true, maxUsers: 25 },
  mailbox: defaultMailboxConfig,
  maxConnectionsPerIp: 50,
  trustProxy: false,
};

/**
 * A coordination server. Holds signed metadata, tracks presence, elects
 * session hosts and relays signalling. Voice and text never pass through it.
 * Embeddable: the desktop app runs one of these when the user opts in.
 */
export class Coordinator {
  readonly config: CoordinatorConfig;
  readonly log: Logger;
  readonly store: Store;
  readonly identity: Identity;
  readonly records: RecordService;
  readonly presence: PresenceService;
  readonly sessions: SessionService;
  readonly mesh: Mesh;
  readonly mailbox: MailboxService;
  private directory?: DirectoryClient;
  private app?: FastifyInstance;
  turn?: TurnServer;
  private _info?: ServerInfo;
  /** userId -> grant expiry */
  private relayGrants = new Map<
    string,
    { expiresAt: number; timer: ReturnType<typeof setTimeout> }
  >();
  /** Device-link codes opened on this server. */
  private links = new Map<
    string,
    { peer: string; key: string; encKey: string; expiresAt: number; claimedBy?: string }
  >();
  /** Codes this server resolved for a claiming device (code -> target peer). */
  private claims = new Map<string, { peer: string; by: string; expiresAt: number }>();

  constructor(config: Partial<CoordinatorConfig> & Pick<CoordinatorConfig, 'name'>) {
    this.config = { ...defaultConfig, ...config };
    // A typo (NaN) or zero here would silently switch a protection off.
    for (const [name, n] of [
      ['capacity', this.config.capacity],
      ['maxConnectionsPerIp', this.config.maxConnectionsPerIp],
      ['relay.maxUsers', this.config.relay.maxUsers],
    ] as const) {
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error(`${name} must be a positive whole number, got ${n}`);
    }
    this.log = consoleLogger(`coord:${this.config.name}`, this.config.logLevel ?? 'info');
    this.store = openStore({ dataDir: this.config.dataDir, kind: this.config.storage });
    let seed = this.config.seed ?? this.store.getMeta('server-seed');
    if (!seed) {
      seed = toB64u(randomBytes(32));
      this.store.setMeta('server-seed', seed);
    }
    this.identity = identityFromSeed(fromB64u(seed));
    this.records = new RecordService(this.store, this.log);
    this.presence = new PresenceService(this);
    this.sessions = new SessionService(this);
    this.mesh = new Mesh(this);
    this.mailbox = new MailboxService(this);
    this.records.onAccepted((record, seq, origin) => {
      this.mesh.onRecord(record, seq, origin);
      this.pushRecordToClients(record);
    });
  }

  get info(): ServerInfo {
    if (!this._info) throw new Error('coordinator not started');
    return this._info;
  }

  get url(): string {
    return this.info.url;
  }

  async start(): Promise<this> {
    const app = Fastify({
      logger: false,
      bodyLimit: 1024 * 1024,
      trustProxy: this.config.trustProxy,
    });
    this.app = app;
    await app.register(websocket, { options: { maxPayload: LIMITS.wsMessageMaxBytes } });
    app.addHook('onSend', async (_req, reply) => {
      reply.header('access-control-allow-origin', '*');
    });
    app.get('/health', async () => ({
      ok: true,
      id: this.identity.userId,
      name: this.config.name,
      version: COORDINATOR_VERSION,
      protocol: PROTOCOL_VERSION,
      users: this.presence.localCount,
      capacity: this.config.capacity,
      peers: this.mesh.peerIds().length,
      time: Date.now(),
      source: this.config.sourceUrl ?? SOURCE_URL,
    }));
    app.get('/v1/info', async () => ({
      server: this.info,
      stun: this.stunUrls(),
      // Other servers' addresses are only shown obfuscated.
      peers: this.mesh.peers().map(toPublicServerInfo),
      source: this.config.sourceUrl ?? SOURCE_URL,
    }));
    app.register(async (scope) => {
      scope.get('/v1/client', { websocket: true }, (socket, req) => {
        if (!this.admit(socket, req.ip)) return;
        // Capacity is enforced when the device authenticates (see hasRoomFor).
        new ClientConnection(this, socket);
      });
      scope.get('/v1/federation', { websocket: true }, (socket, req) => {
        if (!this.admit(socket, req.ip)) return;
        this.mesh.accept(socket);
      });
    });

    await app.listen({ host: this.config.host, port: this.config.port });
    const port = (app.server.address() as AddressInfo).port;
    const publicUrl = (
      this.config.publicUrl ?? `http://${hostForUrl(this.config.host)}:${port}`
    ).replace(/\/$/, '');
    this._info = {
      id: this.identity.userId,
      key: this.identity.publicKey,
      name: this.config.name,
      url: publicUrl,
      version: COORDINATOR_VERSION,
      ...(this.config.region ? { region: this.config.region } : {}),
    };

    if (this.config.stunPort !== null) {
      // One UDP port serves STUN for everyone and TURN for opted-in relay grants.
      try {
        this.turn = await new TurnServer({
          port: this.config.stunPort,
          host: this.config.host.includes(':') ? '::' : '0.0.0.0',
          relayIp: await this.relayIp(publicUrl),
          secret: Buffer.from(randomBytes(32)),
          limits: { maxUsers: this.config.relay.maxUsers },
          allowPrivatePeers: this.config.relay.allowPrivatePeers,
          log: (m, e) => this.log.debug(m, e),
        }).start();
        this.stunPortBound = this.turn.port;
      } catch (err) {
        this.log.warn('STUN/TURN server disabled', { err: String(err) });
      }
    }

    this.mesh.start(this.config.meshPeers);
    if (this.config.directoryUrls.length) {
      this.directory = new DirectoryClient(this, this.config.directoryUrls);
      this.directory.start();
    }
    this.log.info('coordination server listening', {
      url: publicUrl,
      id: this.info.id,
      store: this.store.kind,
    });
    return this;
  }

  private stunPortBound?: number;

  private async relayIp(publicUrl: string): Promise<string> {
    if (this.config.relay.publicIp) return this.config.relay.publicIp;
    const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return host;
    try {
      return (await lookup(host)).address;
    } catch {
      return '127.0.0.1';
    }
  }

  stunUrls(): string[] {
    const urls = [...this.config.extraStun];
    if (this.stunPortBound)
      urls.unshift(`stun:${new URL(this.info.url).hostname}:${this.stunPortBound}`);
    return urls;
  }

  directoryEntry(): DirectoryEntry {
    const load = { users: this.presence.localCount, capacity: this.config.capacity };
    const signedAt = Date.now();
    return {
      server: this.info,
      load,
      signedAt,
      sig: sign(this.identity, SIG_DOMAIN.directory, { server: this.info, load, signedAt }),
    };
  }

  /** Open WebSocket connections per remote IP. */
  private connectionsByIp = new Map<string, number>();

  /** Per-IP connection limit, so one machine cannot exhaust a (home) server. */
  private admit(
    socket: {
      close(code?: number, reason?: string): void;
      on(ev: 'close', fn: () => void): unknown;
    },
    ip: string,
  ) {
    const n = this.connectionsByIp.get(ip) ?? 0;
    if (n >= this.config.maxConnectionsPerIp) {
      this.log.info('too many connections from one address', { ip });
      socket.close(1008, 'too many connections from your address');
      return false;
    }
    this.connectionsByIp.set(ip, n + 1);
    socket.on('close', () => {
      const left = (this.connectionsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.connectionsByIp.delete(ip);
      else this.connectionsByIp.set(ip, left);
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /** Deliver an event to every device of a user, wherever in the mesh they are. */
  deliver<E extends keyof ServerEvents>(userId: string, ev: E, d: ServerEvents[E]): boolean {
    let delivered = this.deliverLocal(userId, ev, d);
    for (const server of this.presence.remoteServersOf(userId)) {
      if (server !== this.info.id && this.mesh.sendTo(server, { t: 'route', to: userId, ev, d }))
        delivered = true;
    }
    return delivered;
  }

  /** Deliver an event to one device (`<userId>.<deviceId>`). */
  deliverToPeer<E extends keyof ServerEvents>(peer: string, ev: E, d: ServerEvents[E]): boolean {
    if (this.deliverLocal(peer, ev, d)) return true;
    const server = this.presence.locatePeer(peer);
    if (!server || server === this.info.id) return false;
    return this.mesh.sendTo(server, { t: 'route', to: peer, ev, d });
  }

  /** `to` is a user id (all local devices) or a peer id (one device). */
  deliverLocal<E extends keyof ServerEvents>(to: string, ev: E, d: ServerEvents[E]): boolean {
    const targets = to.includes('.')
      ? [this.presence.localPeer(to)].filter((c): c is NonNullable<typeof c> => !!c)
      : this.presence.localOf(to);
    if (targets.length === 0) return false;
    if (ev === 'session') this.sessions.noteState((d as ServerEvents['session']).state);
    for (const client of targets) client.send(ev, d);
    return true;
  }

  private pushRecordToClients(record: SignedRecord) {
    let friendOf: Set<string> | undefined;
    if (record.kind === 'friends')
      friendOf = new Set((record as SignedRecord<'friends'>).body.friends);
    // Your own memberships reach all your devices (a space joined on another device).
    const memberOf =
      record.kind === 'member' ? (record as SignedRecord<'member'>).body.userId : undefined;
    for (const client of this.presence.localClients()) {
      if (
        (client as ClientConnection).wants(record) ||
        friendOf?.has(client.userId) ||
        memberOf === client.userId
      ) {
        client.send('record', { record });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Opt-in relay grants
  // -------------------------------------------------------------------------

  requestRelay(client: ClientConnection, sessionId: string): RelayGrant {
    if (!this.config.relay.enabled || !this.turn)
      throw new RpcFailure('unavailable', 'this server does not offer a relay');
    if (!this.sessions.inSession(client.peer, sessionId))
      throw new RpcFailure('forbidden', 'join the session first');
    const now = Date.now();
    for (const [u, g] of this.relayGrants) if (g.expiresAt <= now) this.endRelay(u, 'expired');
    let grant = this.relayGrants.get(client.userId);
    if (!grant) {
      if (this.relayGrants.size >= this.config.relay.maxUsers) {
        throw new RpcFailure('unavailable', 'the relay on this server is at capacity right now');
      }
      const expiresAt = now + this.turn.limits.maxGrantMs;
      const timer = setTimeout(
        () => this.endRelay(client.userId, 'The one-hour relay window ended'),
        expiresAt - now,
      );
      timer.unref?.();
      grant = { expiresAt, timer };
      this.relayGrants.set(client.userId, grant);
      this.log.info('relay granted', { user: client.userId, active: this.relayGrants.size });
    }
    const creds = this.turn.credentials(client.userId, grant.expiresAt);
    const host = new URL(this.info.url).hostname;
    return {
      urls: [`turn:${host.includes(':') ? `[${host}]` : host}:${this.turn.port}?transport=udp`],
      username: creds.username,
      credential: creds.credential,
      expiresAt: grant.expiresAt,
      server: this.info.name,
    };
  }

  endRelay(userId: string, reason: string) {
    const g = this.relayGrants.get(userId);
    if (!g) return;
    clearTimeout(g.timer);
    this.relayGrants.delete(userId);
    this.turn?.dropUser(userId);
    this.deliver(userId, 'relay_expired', { reason });
  }

  relayStats() {
    return {
      enabled: this.config.relay.enabled,
      activeUsers: this.relayGrants.size,
      maxUsers: this.config.relay.maxUsers,
    };
  }

  // -------------------------------------------------------------------------
  // Device linking
  // -------------------------------------------------------------------------

  openLink(client: ClientConnection): { code: string; expiresAt: number } {
    const now = Date.now();
    for (const [c, l] of this.links)
      if (l.expiresAt < now || l.peer === client.peer) this.links.delete(c);
    const code = randomId(5); // 40 bits; claims are rate limited
    const expiresAt = now + 10 * 60_000;
    this.links.set(code, {
      peer: client.peer,
      key: client.publicKey,
      encKey: client.encKey,
      expiresAt,
    });
    return { code, expiresAt };
  }

  /** Local lookup used by link.claim and by mesh link queries. */
  findLink(code: string) {
    const l = this.links.get(code);
    return l && l.expiresAt > Date.now() && !l.claimedBy ? l : undefined;
  }

  async claimLink(
    client: ClientConnection,
    code: string,
  ): Promise<{ peer: string; key: string; encKey: string }> {
    const clean = code
      .trim()
      .toLowerCase()
      .replace(/[^a-z2-7]/g, '');
    let found: { peer: string; key: string; encKey: string } | undefined = this.findLink(clean);
    if (found) this.links.get(clean)!.claimedBy = client.peer;
    else found = await this.mesh.queryLink(clean);
    if (!found)
      throw new RpcFailure(
        'not_found',
        'That code is not valid (or expired). Check it and try again.',
      );
    this.claims.set(clean, {
      peer: found.peer,
      by: client.peer,
      expiresAt: Date.now() + 10 * 60_000,
    });
    this.deliverToPeer(found.peer, 'link_claimed', {
      key: client.publicKey,
      userId: client.userId,
    });
    return { peer: found.peer, key: found.key, encKey: found.encKey };
  }

  sendLink(client: ClientConnection, code: string, box: LinkBox) {
    const clean = code
      .trim()
      .toLowerCase()
      .replace(/[^a-z2-7]/g, '');
    const claim = this.claims.get(clean);
    if (!claim || claim.by !== client.peer || claim.expiresAt < Date.now())
      throw new RpcFailure('not_found', 'claim the code first');
    this.claims.delete(clean);
    if (!this.deliverToPeer(claim.peer, 'link_payload', { box }))
      throw new RpcFailure('unavailable', 'the new device went offline');
  }

  isSpaceMember(spaceId: string, userId: string) {
    return isSpaceMember(this.records, spaceId, userId);
  }

  searchUsers(query: string): SignedRecord<'profile'>[] {
    const q = query.trim().toLowerCase();
    const [name, tag] = q.split('#') as [string, string?];
    // Exact user id lookups are handy for invites and QR codes.
    if (/^[a-z2-7]{26}$/.test(q)) {
      const p = this.store.get(`profile:${q}`);
      return p ? [p as SignedRecord<'profile'>] : [];
    }
    const found = this.store.findByTerm(`name:${name}`, 50) as SignedRecord<'profile'>[];
    if (!tag) return found;
    return found.filter((p) => userTag(p.key.slice('profile:'.length)) === tag);
  }

  // -------------------------------------------------------------------------
  // Lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Whether a device that just proved its identity may stay. Checked and
   * followed by attach() in the same synchronous step, so concurrent logins
   * cannot overshoot the capacity; a device replacing its own older
   * connection always fits.
   */
  hasRoomFor(peer: string) {
    return !!this.presence.localPeer(peer) || this.presence.localCount < this.config.capacity;
  }

  onClientAuthed(client: ClientConnection) {
    const previous = this.presence.attach(client);
    if (previous && previous !== client) {
      previous.send('replaced', { reason: 'this device connected again elsewhere' });
      previous.close(4009, 'replaced');
      // Give the new connection a moment to re-join before tearing sessions down.
      this.sessions.onClientReplaced(previous.peer);
    }
  }

  onClientClosed(client: ClientConnection) {
    if (this.presence.detach(client)) this.sessions.onClientGone(client.peer);
  }

  onServerUp(_serverId: string) {
    this.sessions.onServerUp();
  }

  onServerDown(serverId: string) {
    this.presence.dropServer(serverId);
    this.sessions.onServerDown(serverId);
  }

  private stopped = false;

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.directory?.stop();
    this.mesh.close();
    this.sessions.close();
    this.mailbox.close();
    for (const g of this.relayGrants.values()) clearTimeout(g.timer);
    this.turn?.stop();
    await this.app?.close();
    this.store.close();
  }
}

function hostForUrl(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}
