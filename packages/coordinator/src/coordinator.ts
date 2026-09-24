import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { identityFromSeed, isSpaceMember, randomBytes, sign, userTag, type Identity } from '@crocodile/crypto';
import {
  fromB64u,
  LIMITS,
  PROTOCOL_VERSION,
  SIG_DOMAIN,
  toB64u,
  type DirectoryEntry,
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
import { startStunServer } from './stun';
import { consoleLogger, type Logger } from './util';

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
}

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
  private directory?: DirectoryClient;
  private app?: FastifyInstance;
  private stun?: Socket;
  private _info?: ServerInfo;

  constructor(config: Partial<CoordinatorConfig> & Pick<CoordinatorConfig, 'name'>) {
    this.config = { ...defaultConfig, ...config };
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
    const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
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
      users: this.presence.local.size,
      capacity: this.config.capacity,
      peers: this.mesh.peerIds().length,
      time: Date.now(),
    }));
    app.get('/v1/info', async () => ({ server: this.info, stun: this.stunUrls(), peers: this.mesh.peers() }));
    app.register(async (scope) => {
      scope.get('/v1/client', { websocket: true }, (socket) => {
        new ClientConnection(this, socket);
      });
      scope.get('/v1/federation', { websocket: true }, (socket) => {
        this.mesh.accept(socket);
      });
    });

    await app.listen({ host: this.config.host, port: this.config.port });
    const port = (app.server.address() as AddressInfo).port;
    const publicUrl = (this.config.publicUrl ?? `http://${hostForUrl(this.config.host)}:${port}`).replace(/\/$/, '');
    this._info = {
      id: this.identity.userId,
      key: this.identity.publicKey,
      name: this.config.name,
      url: publicUrl,
      version: COORDINATOR_VERSION,
      ...(this.config.region ? { region: this.config.region } : {}),
    };

    if (this.config.stunPort !== null) {
      const stunPort = this.config.stunPort === 0 ? 0 : this.config.stunPort;
      try {
        this.stun = await startStunServer(stunPort, this.config.host.includes(':') ? '::' : '0.0.0.0');
        const bound = (this.stun.address() as AddressInfo).port;
        this.stunPortBound = bound;
      } catch (err) {
        this.log.warn('STUN server disabled', { err: String(err) });
      }
    }

    this.mesh.start(this.config.meshPeers);
    if (this.config.directoryUrls.length) {
      this.directory = new DirectoryClient(this, this.config.directoryUrls);
      this.directory.start();
    }
    this.log.info('coordination server listening', { url: publicUrl, id: this.info.id, store: this.store.kind });
    return this;
  }

  private stunPortBound?: number;

  stunUrls(): string[] {
    const urls = [...this.config.extraStun];
    if (this.stunPortBound) urls.unshift(`stun:${new URL(this.info.url).hostname}:${this.stunPortBound}`);
    return urls;
  }

  directoryEntry(): DirectoryEntry {
    const load = { users: this.presence.local.size, capacity: this.config.capacity };
    const signedAt = Date.now();
    return {
      server: this.info,
      load,
      signedAt,
      sig: sign(this.identity, SIG_DOMAIN.directory, { server: this.info, load, signedAt }),
    };
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /** Deliver an event to a user wherever in the mesh they are connected. */
  deliver<E extends keyof ServerEvents>(userId: string, ev: E, d: ServerEvents[E]): boolean {
    if (this.deliverLocal(userId, ev, d)) return true;
    const serverId = this.presence.locate(userId);
    if (!serverId || serverId === this.info.id) return false;
    return this.mesh.sendTo(serverId, { t: 'route', to: userId, ev, d });
  }

  deliverLocal<E extends keyof ServerEvents>(userId: string, ev: E, d: ServerEvents[E]): boolean {
    const client = this.presence.local.get(userId);
    if (!client) return false;
    if (ev === 'session') this.sessions.noteState((d as ServerEvents['session']).state);
    client.send(ev, d);
    return true;
  }

  private pushRecordToClients(record: SignedRecord) {
    let friendOf: Set<string> | undefined;
    if (record.kind === 'friends') friendOf = new Set((record as SignedRecord<'friends'>).body.friends);
    for (const client of this.presence.local.values()) {
      if ((client as ClientConnection).wants(record) || friendOf?.has(client.userId)) {
        client.send('record', { record });
      }
    }
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

  onClientAuthed(client: ClientConnection) {
    const previous = this.presence.attach(client);
    if (previous && previous !== client) {
      previous.send('replaced', { reason: 'signed in from another connection' });
      previous.close(4009, 'replaced');
      // Give the new connection a moment to re-join before tearing sessions down.
      this.sessions.onClientReplaced(previous.userId);
    }
  }

  onClientClosed(client: ClientConnection) {
    if (this.presence.detach(client)) this.sessions.onClientGone(client.userId);
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
    this.stun?.close();
    await this.app?.close();
    this.store.close();
  }
}

function hostForUrl(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}
