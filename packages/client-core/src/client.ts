import {
  createChatMessage,
  createIdentity,
  decodeRecoveryKey,
  encodeRecoveryKey,
  identityFromSeed,
  isSpaceMember,
  randomId,
  signRecord,
  spaceIdFor,
  userTag,
  verifyChatMessage,
  type Identity,
} from '@crocodile/crypto';
import {
  LIMITS,
  fromB64u,
  parseSessionId,
  recordKey,
  sessionIds,
  toB64u,
  type Channel,
  type ChannelKind,
  type ChatMessage,
  type FriendsBody,
  type HostCaps,
  type PresenceStatus,
  type ProfileBody,
  type ServerInfo,
  type SessionState,
  type SignedRecord,
  type SpaceBody,
  type VoiceOccupancy,
} from '@crocodile/protocol';
import { CoordinatorLink, type LinkStatus } from './coordinator-link';
import { Emitter } from './emitter';
import { GroupSession, defaultTransportFactory, type RelayStatus, type TransportFactory } from './group-session';
import type { PlatformAdapter } from './platform';
import { RecordCache } from './records-cache';
import type { RankedServer } from './server-selection';
import { StateStore } from './store';
import type { VoiceEngine } from './voice';

export interface ClientConfig {
  /** Directory services used to discover coordination servers. */
  directories: string[];
  /** Coordination servers to try before the directory's picks. */
  preferredServers?: string[];
  /** Override the WebRTC transport (tests). */
  transportFactory?: TransportFactory;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Settings {
  /** Let this device act as session host (relay) when elected. */
  allowHosting: boolean;
  /** Self-reported upload bandwidth, used as a hint for host election. */
  uplinkKbps?: number;
  preferredServers: string[];
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  notifications: boolean;
}

export const defaultSettings: Settings = {
  allowHosting: true,
  preferredServers: [],
  status: 'online',
  notifications: true,
};

export interface ProfileView {
  userId: string;
  username: string;
  tag: string;
  avatar?: string;
  bio?: string;
  accent?: string;
  encKey: string;
  publicKey: string;
}

export interface SpaceView {
  id: string;
  name: string;
  icon?: string;
  owner: string;
  channels: Channel[];
  members: string[];
  bans: string[];
}

export interface SessionView {
  id: string;
  status: RelayStatus;
  host: string | null;
  backup: string | null;
  epoch: number;
  members: string[];
  peers: string[];
  speaking: string[];
  muted: string[];
  deafened: string[];
  iAmHost: boolean;
}

export interface MessageView extends ChatMessage {
  edited?: boolean;
  pending?: boolean;
}

export interface ClientState {
  phase: 'loading' | 'onboarding' | 'ready';
  link: LinkStatus;
  server: { info: ServerInfo; rttMs: number } | null;
  servers: RankedServer[];
  me: ProfileView | null;
  profiles: Record<string, ProfileView>;
  presence: Record<string, PresenceStatus>;
  friends: { friends: string[]; incoming: string[]; outgoing: string[]; blocked: string[] };
  spaces: Record<string, SpaceView>;
  voice: Record<string, VoiceOccupancy>;
  sessions: Record<string, SessionView>;
  dms: string[];
  messages: Record<string, MessageView[]>;
  unread: Record<string, number>;
  typing: Record<string, Record<string, number>>;
  activeChannel: string | null;
  voiceSession: string | null;
  /** Someone is ringing us in a DM. */
  incomingCall: { sessionId: string; from: string; at: number } | null;
  /** We are ringing someone and they have not answered yet. */
  outgoingCall: { sessionId: string; to: string; at: number } | null;
  muted: boolean;
  deafened: boolean;
  settings: Settings;
  errors: { id: number; message: string }[];
}

export type ClientEvents = {
  message: { channel: string; message: ChatMessage; mine: boolean };
  error: { message: string };
};

const APP_VERSION_FALLBACK = '0.1.0';

/**
 * The whole client behind one object. UIs render `store` and call methods;
 * nothing here is specific to a UI toolkit or to Electron.
 */
export class CrocodileClient extends Emitter<ClientEvents> {
  readonly store: StateStore<ClientState>;
  identity: Identity | null = null;
  link?: CoordinatorLink;
  readonly records: RecordCache;
  private sessions = new Map<string, GroupSession>();
  private transportFactory?: TransportFactory;
  private stun: string[] = [];
  private errorId = 0;
  voiceEngine?: VoiceEngine;

  constructor(
    readonly platform: PlatformAdapter,
    readonly config: ClientConfig,
  ) {
    super();
    this.records = new RecordCache(platform.kv);
    this.transportFactory = config.transportFactory ?? defaultTransportFactory(platform);
    this.store = new StateStore<ClientState>({
      phase: 'loading',
      link: 'idle',
      server: null,
      servers: [],
      me: null,
      profiles: {},
      presence: {},
      friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
      spaces: {},
      voice: {},
      sessions: {},
      dms: [],
      messages: {},
      unread: {},
      typing: {},
      activeChannel: null,
      voiceSession: null,
      incomingCall: null,
      outgoingCall: null,
      muted: false,
      deafened: false,
      settings: defaultSettings,
      errors: [],
    });
    this.records.on('changed', (r) => this.onRecordChanged(r));
  }

  get state() {
    return this.store.get();
  }

  /** STUN servers handed out by the current coordination server. */
  get stunUrls(): string[] {
    return this.stun;
  }

  get userId(): string {
    if (!this.identity) throw new Error('not signed in');
    return this.identity.userId;
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.config.log?.(msg, extra);
  }

  reportError(message: string) {
    const id = ++this.errorId;
    this.store.set((s) => ({ errors: [...s.errors.slice(-4), { id, message }] }));
    this.emit('error', { message });
    setTimeout(() => this.store.set((s) => ({ errors: s.errors.filter((e) => e.id !== id) })), 8000);
  }

  // ===========================================================================
  // Identity and onboarding
  // ===========================================================================

  /** Loads the saved identity; if there is none the UI shows onboarding. */
  async init() {
    const settings = { ...defaultSettings, ...((await this.platform.kv.get<Partial<Settings>>('settings')) ?? {}) };
    const dms = (await this.platform.kv.get<string[]>('dms')) ?? [];
    this.store.set({ settings, dms });
    await this.records.load();
    const seed = await this.platform.kv.get<string>('identity-seed');
    if (!seed) {
      this.store.set({ phase: 'onboarding' });
      return;
    }
    this.identity = identityFromSeed(fromB64u(seed));
    this.refreshDerivedState();
    this.store.set({ phase: 'ready' });
    this.connect();
  }

  /** First run: create an identity and publish the profile. */
  async createAccount(username: string, avatar?: string) {
    const identity = createIdentity();
    await this.adoptIdentity(identity);
    await this.saveProfile({ username: username.trim(), ...(avatar ? { avatar } : {}) });
  }

  /** Restore an existing identity from its recovery key. */
  async restoreAccount(recoveryKey: string, usernameIfNew?: string) {
    const identity = identityFromSeed(decodeRecoveryKey(recoveryKey));
    await this.adoptIdentity(identity);
    const existing = await this.link!.request('records.get', { keys: [recordKey.profile(identity.userId)] }).catch(() => null);
    if (existing?.records[0]) this.records.ingest(existing.records[0]);
    else if (usernameIfNew) await this.saveProfile({ username: usernameIfNew });
  }

  private async adoptIdentity(identity: Identity) {
    this.identity = identity;
    await this.platform.kv.set('identity-seed', toB64u(identity.seed));
    this.connect();
  }

  /** Onboarding UIs call this once the user has seen their recovery key. */
  finishOnboarding() {
    if (this.identity) this.store.set({ phase: 'ready' });
  }

  recoveryKey(): string {
    if (!this.identity) throw new Error('not signed in');
    return encodeRecoveryKey(this.identity.seed);
  }

  /** Forget this device's identity (the user should have saved the recovery key). */
  async signOut() {
    for (const s of this.sessions.values()) await s.leave();
    this.sessions.clear();
    this.link?.stop();
    this.link = undefined;
    await this.platform.kv.delete('identity-seed');
    await this.platform.kv.delete('records-cache');
    this.identity = null;
    this.store.set({ phase: 'onboarding', me: null, spaces: {}, sessions: {}, messages: {} });
  }

  async updateSettings(patch: Partial<Settings>) {
    const settings = { ...this.state.settings, ...patch };
    this.store.set({ settings });
    await this.platform.kv.set('settings', settings);
    if (patch.status) void this.link?.request('presence.set', { status: patch.status }).catch(() => {});
    if (patch.allowHosting !== undefined || patch.uplinkKbps !== undefined) {
      for (const s of this.sessions.values()) void s.updateCaps();
    }
    if (patch.preferredServers) {
      this.link?.stop();
      this.connect();
    }
  }

  // ===========================================================================
  // Coordination link
  // ===========================================================================

  private connect() {
    if (!this.identity) return;
    this.link?.stop();
    const link = new CoordinatorLink({
      identity: this.identity,
      platform: this.platform.platform,
      version: this.platform.appVersion || APP_VERSION_FALLBACK,
      kv: this.platform.kv,
      directories: this.config.directories,
      preferredServers: [...this.state.settings.preferredServers, ...(this.config.preferredServers ?? [])],
      fetchImpl: this.platform.fetch,
      WebSocketImpl: this.platform.WebSocketImpl,
    });
    this.link = link;
    link.on('status', (status) => this.store.set({ link: status }));
    link.on('servers', (servers) => this.store.set({ servers }));
    link.on('connected', ({ server, rttMs, stun }) => {
      this.stun = stun;
      this.store.set({ server: { info: server, rttMs } });
      void this.onConnected().catch((err) => this.log('post-connect sync failed', { err: String(err) }));
    });
    link.on('disconnected', () => this.store.set({ server: null }));
    link.on('record', ({ record }) => this.records.ingest(record));
    link.on('presence', (p) => this.store.set((s) => ({ presence: { ...s.presence, [p.userId]: p.status } })));
    link.on('session', ({ state }) => this.sessions.get(state.id)?.applyState(state));
    link.on('signal', ({ from, sessionId, data }) => this.sessions.get(sessionId)?.handleSignal(from, data));
    link.on('voice', (occ) => this.setOccupancy(occ));
    link.on('session_invite', ({ sessionId, from }) => void this.onSessionInvite(sessionId, from));
    link.on('replaced', () => this.reportError('Signed in from another window or device; this one is now offline.'));
    link.start();
  }

  private async onConnected() {
    const link = this.link!;
    const me = this.userId;
    await this.ensureProfilePublished();

    const [mine, incoming, own] = await Promise.all([
      link.request('spaces.mine', {}),
      link.request('friends.incoming', {}),
      link.request('records.get', { keys: [recordKey.profile(me), recordKey.friends(me)] }),
    ]);
    this.records.ingestAll([...own.records, ...mine.spaces, ...mine.members, ...incoming.records]);
    const spaceIds = mine.spaces.map((s) => s.key.slice('space:'.length));
    // Members of our spaces, so we can verify peers and show member lists.
    for (const id of spaceIds) {
      const members = await link.request('records.list', { prefix: recordKey.memberPrefix(id) });
      this.records.ingestAll(members.records);
    }
    await link.request('records.subscribe', {
      prefixes: [
        recordKey.profile(me),
        recordKey.friends(me),
        ...spaceIds.flatMap((id) => [recordKey.space(id), recordKey.memberPrefix(id)]),
      ],
    });
    await this.syncProfiles();
    if (this.state.settings.status !== 'online') await link.request('presence.set', { status: this.state.settings.status });
    const { voice } = await link.request('voice.watch', { spaceIds });
    this.store.set({ voice: Object.fromEntries(voice.map((v) => [sessionIds.voice(v.spaceId, v.channelId), v])) });

    // (Re)join sessions: every space's text mesh, plus whatever voice/DM we were in.
    for (const id of spaceIds) this.ensureSession(sessionIds.space(id));
    for (const s of this.sessions.values()) void s.join().catch((err) => this.log('join failed', { id: s.sessionId, err: String(err) }));
  }

  private async ensureProfilePublished() {
    const me = this.userId;
    const res = await this.link!.request('records.get', { keys: [recordKey.profile(me)] });
    const remote = res.records[0];
    if (remote) this.records.ingest(remote);
    const local = this.records.get(recordKey.profile(me));
    if (local && (!remote || remote.version < local.version)) await this.link!.request('records.put', { record: local });
  }

  /** Fetch profiles of everyone we show: friends, requests, space members. */
  private async syncProfiles() {
    const ids = this.relevantUsers();
    const missing = ids.filter((id) => id !== this.userId);
    for (let i = 0; i < missing.length; i += 400) {
      const keys = missing.slice(i, i + 400).map((id) => recordKey.profile(id));
      const res = await this.link!.request('records.get', { keys });
      this.records.ingestAll(res.records);
    }
    await this.link!.request('records.subscribe', { prefixes: missing.map((id) => recordKey.profile(id)) });
    const { presence } = await this.link!.request('presence.subscribe', { userIds: missing });
    this.store.set({ presence: Object.fromEntries(presence.map((p) => [p.userId, p.status])) });
  }

  private relevantUsers(): string[] {
    const s = this.state;
    const set = new Set<string>([...s.friends.friends, ...s.friends.incoming, ...s.friends.outgoing, ...s.dms]);
    for (const space of Object.values(s.spaces)) for (const m of space.members) set.add(m);
    return [...set];
  }

  private async fetchProfiles(userIds: string[]) {
    const missing = userIds.filter((id) => !this.records.get(recordKey.profile(id)));
    if (!missing.length || !this.link) return;
    const res = await this.link.request('records.get', { keys: missing.map((id) => recordKey.profile(id)) }).catch(() => null);
    if (res) this.records.ingestAll(res.records);
    await this.link.request('records.subscribe', { prefixes: missing.map((id) => recordKey.profile(id)) }).catch(() => {});
    const p = await this.link.request('presence.subscribe', { userIds: missing }).catch(() => null);
    if (p) this.store.set((s) => ({ presence: { ...s.presence, ...Object.fromEntries(p.presence.map((e) => [e.userId, e.status])) } }));
  }

  // ===========================================================================
  // Derived state from records
  // ===========================================================================

  private onRecordChanged(record: SignedRecord) {
    if (!this.identity) return;
    this.refreshDerivedState(record);
    if (record.kind === 'friends' || record.kind === 'member') {
      void this.fetchProfiles(this.relevantUsers()).catch(() => {});
    }
  }

  private profileView(r: SignedRecord<'profile'>): ProfileView {
    const userId = r.key.slice('profile:'.length);
    const b = r.body as ProfileBody;
    return {
      userId,
      username: b.username,
      tag: userTag(userId),
      avatar: b.avatar,
      bio: b.bio,
      accent: b.accent,
      encKey: b.encKey,
      publicKey: r.author,
    };
  }

  private refreshDerivedState(changed?: SignedRecord) {
    const me = this.identity?.userId;
    if (!me) return;
    const patch: Partial<ClientState> = {};
    if (!changed || changed.kind === 'profile') {
      const profiles: Record<string, ProfileView> = {};
      for (const r of this.records.list('profile:')) {
        const v = this.profileView(r as SignedRecord<'profile'>);
        profiles[v.userId] = v;
      }
      patch.profiles = profiles;
      patch.me = profiles[me] ?? null;
    }
    if (!changed || changed.kind === 'friends') {
      const mine = (this.records.get(recordKey.friends(me)) as SignedRecord<'friends'> | undefined)?.body ?? {
        friends: [],
        blocked: [],
      };
      const listsMe = new Set<string>();
      for (const r of this.records.list('friends:')) {
        const owner = r.key.slice('friends:'.length);
        if (owner !== me && (r.body as FriendsBody).friends.includes(me)) listsMe.add(owner);
      }
      const blocked = new Set(mine.blocked);
      patch.friends = {
        friends: mine.friends.filter((f) => listsMe.has(f)),
        outgoing: mine.friends.filter((f) => !listsMe.has(f)),
        incoming: [...listsMe].filter((u) => !mine.friends.includes(u) && !blocked.has(u)),
        blocked: mine.blocked,
      };
    }
    if (!changed || changed.kind === 'space' || changed.kind === 'member') {
      const spaces: Record<string, SpaceView> = {};
      for (const r of this.records.list('space:')) {
        const id = r.key.slice('space:'.length);
        const body = r.body as SpaceBody;
        if (body.deleted || !isSpaceMember(this.records, id, me)) continue;
        const members = new Set<string>([body.owner]);
        for (const m of this.records.list(recordKey.memberPrefix(id))) {
          const mb = m.body as { userId: string; left?: boolean };
          if (!mb.left && !body.bans.includes(mb.userId)) members.add(mb.userId);
        }
        spaces[id] = {
          id,
          name: body.name,
          icon: body.icon,
          owner: body.owner,
          channels: body.channels,
          members: [...members],
          bans: body.bans,
        };
      }
      patch.spaces = spaces;
      // Leave sessions of spaces we no longer belong to.
      for (const [sid, session] of this.sessions) {
        const scope = parseSessionId(sid);
        if (scope && scope.kind !== 'dm' && !spaces[scope.spaceId]) {
          void session.leave();
          this.sessions.delete(sid);
        }
      }
    }
    this.store.set(patch);
  }

  private setOccupancy(occ: VoiceOccupancy) {
    const id = sessionIds.voice(occ.spaceId, occ.channelId);
    this.store.set((s) => {
      const voice = { ...s.voice };
      if (occ.members.length === 0) delete voice[id];
      else voice[id] = occ;
      return { voice };
    });
    void this.fetchProfiles(occ.members).catch(() => {});
  }

  // ===========================================================================
  // Profile and friends
  // ===========================================================================

  private async putRecord(record: SignedRecord) {
    this.records.ingest(record);
    const res = await this.link!.request('records.put', { record });
    if (!res.accepted) {
      if (res.current) this.records.ingest(res.current);
      throw new Error(res.reason ?? 'rejected by server');
    }
  }

  async saveProfile(update: Partial<Omit<ProfileBody, 'encKey'>>) {
    const id = this.identity!;
    const current = (this.records.get(recordKey.profile(id.userId)) as SignedRecord<'profile'> | undefined)?.body;
    const body: ProfileBody = {
      ...(current ?? { username: 'crocodile' }),
      ...update,
      encKey: id.encPublicKey,
    };
    for (const k of Object.keys(body) as (keyof ProfileBody)[]) if (body[k] === undefined || body[k] === '') delete body[k];
    if (!body.username) body.username = current?.username ?? 'crocodile';
    const record = signRecord(id, 'profile', recordKey.profile(id.userId), body, this.nextVersion(recordKey.profile(id.userId)));
    this.records.ingest(record);
    await this.putRecord(record).catch((err) => {
      if (this.link?.status === 'connected') throw err;
      // Offline: it is cached locally and published on the next connection.
    });
  }

  private nextVersion(key: string) {
    const existing = this.records.get(key);
    return Math.max(Date.now(), (existing?.version ?? 0) + 1);
  }

  async searchUsers(query: string): Promise<ProfileView[]> {
    const res = await this.link!.request('users.search', { query });
    this.records.ingestAll(res.profiles);
    return res.profiles
      .filter((p) => this.records.get(p.key)?.sig === p.sig)
      .map((p) => this.profileView(p));
  }

  private async writeFriends(mutate: (b: FriendsBody) => FriendsBody) {
    const id = this.identity!;
    const key = recordKey.friends(id.userId);
    const current = (this.records.get(key) as SignedRecord<'friends'> | undefined)?.body ?? { friends: [], blocked: [] };
    const next = mutate({ friends: [...current.friends], blocked: [...current.blocked] });
    next.friends = [...new Set(next.friends)].filter((f) => f !== id.userId);
    next.blocked = [...new Set(next.blocked)];
    await this.putRecord(signRecord(id, 'friends', key, next, this.nextVersion(key)));
  }

  /** Sends a friend request, or accepts one if they already asked. */
  addFriend(userId: string) {
    return this.writeFriends((b) => ({ friends: [...b.friends, userId], blocked: b.blocked.filter((x) => x !== userId) }));
  }

  removeFriend(userId: string) {
    return this.writeFriends((b) => ({ ...b, friends: b.friends.filter((x) => x !== userId) }));
  }

  block(userId: string) {
    return this.writeFriends((b) => ({ friends: b.friends.filter((x) => x !== userId), blocked: [...b.blocked, userId] }));
  }

  unblock(userId: string) {
    return this.writeFriends((b) => ({ ...b, blocked: b.blocked.filter((x) => x !== userId) }));
  }

  async setStatus(status: Settings['status']) {
    await this.updateSettings({ status });
  }

  // ===========================================================================
  // Spaces
  // ===========================================================================

  async createSpace(name: string, icon?: string): Promise<string> {
    const id = this.identity!;
    const nonce = randomId();
    const spaceId = spaceIdFor(id.publicKey, nonce);
    const body: SpaceBody = {
      name: name.trim(),
      owner: id.userId,
      nonce,
      admins: [],
      bans: [],
      channels: [
        { id: randomId(), name: 'general', kind: 'text' },
        { id: randomId(), name: 'General', kind: 'voice' },
      ],
      ...(icon ? { icon } : {}),
    };
    await this.putRecord(signRecord(id, 'space', recordKey.space(spaceId), body));
    await this.putRecord(
      signRecord(id, 'member', recordKey.member(spaceId, id.userId), { spaceId, userId: id.userId }),
    );
    await this.afterSpaceJoined(spaceId);
    return spaceId;
  }

  private async afterSpaceJoined(spaceId: string) {
    await this.link!.request('records.subscribe', { prefixes: [recordKey.space(spaceId), recordKey.memberPrefix(spaceId)] });
    const members = await this.link!.request('records.list', { prefix: recordKey.memberPrefix(spaceId) });
    this.records.ingestAll(members.records);
    const spaceIds = Object.keys(this.state.spaces);
    const { voice } = await this.link!.request('voice.watch', { spaceIds });
    for (const v of voice) this.setOccupancy(v);
    await this.fetchProfiles(this.state.spaces[spaceId]?.members ?? []);
    const session = this.ensureSession(sessionIds.space(spaceId));
    await session.join().catch((err) => this.log('space session join failed', { err: String(err) }));
  }

  private spaceBody(spaceId: string): SpaceBody {
    const r = this.records.get(recordKey.space(spaceId)) as SignedRecord<'space'> | undefined;
    if (!r) throw new Error('unknown space');
    if (r.body.owner !== this.userId) throw new Error('only the owner can change this space');
    return structuredClone(r.body);
  }

  async updateSpace(spaceId: string, mutate: (b: SpaceBody) => SpaceBody) {
    const body = mutate(this.spaceBody(spaceId));
    const key = recordKey.space(spaceId);
    await this.putRecord(signRecord(this.identity!, 'space', key, body, this.nextVersion(key)));
  }

  addChannel(spaceId: string, name: string, kind: ChannelKind) {
    const clean = kind === 'text' ? name.trim().toLowerCase().replace(/\s+/g, '-') : name.trim();
    return this.updateSpace(spaceId, (b) => ({ ...b, channels: [...b.channels, { id: randomId(), name: clean, kind }] }));
  }

  renameChannel(spaceId: string, channelId: string, name: string) {
    return this.updateSpace(spaceId, (b) => ({
      ...b,
      channels: b.channels.map((c) => (c.id === channelId ? { ...c, name: name.trim() } : c)),
    }));
  }

  removeChannel(spaceId: string, channelId: string) {
    return this.updateSpace(spaceId, (b) => ({ ...b, channels: b.channels.filter((c) => c.id !== channelId) }));
  }

  banMember(spaceId: string, userId: string) {
    return this.updateSpace(spaceId, (b) => ({ ...b, bans: [...new Set([...b.bans, userId])] }));
  }

  deleteSpace(spaceId: string) {
    return this.updateSpace(spaceId, (b) => ({ ...b, deleted: true }));
  }

  /** Creates an invite code others can use to join. */
  async createInvite(spaceId: string, expiresInMs: number | null = 7 * 24 * 3600_000): Promise<string> {
    const code = randomId(5);
    await this.putRecord(
      signRecord(this.identity!, 'invite', recordKey.invite(code), {
        spaceId,
        code,
        expiresAt: expiresInMs === null ? null : Date.now() + expiresInMs,
      }),
    );
    return code;
  }

  /** Accepts "abcd1234", "croc://join/abcd1234" or "https://…/join/abcd1234". */
  async joinWithInvite(input: string): Promise<string> {
    const code = input.trim().toLowerCase().split('/').pop()!.replace(/[^a-z2-7]/g, '');
    const res = await this.link!.request('records.get', { keys: [recordKey.invite(code)] });
    const invite = res.records[0] as SignedRecord<'invite'> | undefined;
    if (!invite) throw new Error('That invite does not exist (yet). Check the code and try again.');
    const { spaceId } = invite.body;
    const space = await this.link!.request('records.get', { keys: [recordKey.space(spaceId)] });
    this.records.ingestAll([...space.records, invite]);
    const me = this.userId;
    const key = recordKey.member(spaceId, me);
    await this.putRecord(
      signRecord(this.identity!, 'member', key, { spaceId, userId: me, inviteCode: code }, this.nextVersion(key)),
    );
    await this.afterSpaceJoined(spaceId);
    return spaceId;
  }

  async leaveSpace(spaceId: string) {
    const me = this.userId;
    const key = recordKey.member(spaceId, me);
    await this.putRecord(signRecord(this.identity!, 'member', key, { spaceId, userId: me, left: true }, this.nextVersion(key)));
  }

  // ===========================================================================
  // Sessions
  // ===========================================================================

  private ensureSession(sessionId: string): GroupSession {
    let session = this.sessions.get(sessionId);
    if (session) return session;
    if (!this.transportFactory) throw new Error('This device cannot open peer-to-peer connections');
    const scope = parseSessionId(sessionId);
    const withVoice = scope?.kind === 'voice' || scope?.kind === 'dm' ? this.voiceEngine : undefined;
    session = new GroupSession(
      sessionId,
      {
        identity: this.identity!,
        link: this.link!,
        platform: this.platform,
        messages: this.platform.messages,
        iceServers: () => this.stun.map((urls) => ({ urls })),
        caps: () => this.caps(),
        encKeyOf: (u) => this.encKeyOf(u),
        isAllowedPeer: (sid, u) => this.isAllowedPeer(sid, u),
        historyChannels: (sid) => this.historyChannels(sid),
        acceptMessage: (sid, m) => this.acceptMessage(sid, m),
        log: (m, e) => this.log(m, { session: sessionId, ...e }),
      },
      this.transportFactory,
      withVoice ? { micTrack: () => withVoice.micTrack(), frameCrypto: (k) => withVoice.frameCrypto(k) } : undefined,
    );
    session.on('update', () => this.publishSession(session!));
    session.on('track', (ev) => this.voiceEngine?.playSlot(sessionId, ev.slot, ev.track, () => session!.slots[ev.slot] ?? null));
    session.on('call', ({ userId, action }) => this.onCallSignal(sessionId, userId, action));
    session.on('typing', ({ userId, ch }) => {
      const until = Date.now() + 6000;
      this.store.set((s) => ({ typing: { ...s.typing, [ch]: { ...(s.typing[ch] ?? {}), [userId]: until } } }));
    });
    if (scope?.kind === 'voice') session.isVoice = true;
    this.sessions.set(sessionId, session);
    return session;
  }

  private publishSession(session: GroupSession) {
    const st: SessionState | null = session.state;
    const peers = [...session.peers.values()];
    const view: SessionView = {
      id: session.sessionId,
      status: session.status,
      host: st?.host ?? null,
      backup: st?.backup ?? null,
      epoch: st?.epoch ?? 0,
      members: st?.members.map((m) => m.userId) ?? [],
      peers: peers.map((p) => p.userId),
      speaking: session.speaking,
      muted: peers.filter((p) => p.muted).map((p) => p.userId),
      deafened: peers.filter((p) => p.deafened).map((p) => p.userId),
      iAmHost: session.isHost,
    };
    this.store.set((s) => ({ sessions: { ...s.sessions, [session.sessionId]: view } }));
  }

  sessionFor(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  private async caps(): Promise<HostCaps> {
    const extra: Partial<HostCaps> = (await this.platform.capabilities?.().catch(() => ({}))) ?? {};
    const settings = this.state.settings;
    return {
      canHost: !!this.platform.relay && settings.allowHosting && (extra.canHost ?? true),
      platform: this.platform.platform,
      nat: extra.nat ?? 'unknown',
      ...(settings.uplinkKbps ?? extra.uplinkKbps ? { uplinkKbps: settings.uplinkKbps ?? extra.uplinkKbps } : {}),
      ...(extra.cpuCores ? { cpuCores: extra.cpuCores } : {}),
      ...(extra.onBattery !== undefined ? { onBattery: extra.onBattery } : {}),
      ...(this.state.server ? { rttMs: Math.round(this.state.server.rttMs) } : {}),
    };
  }

  private async encKeyOf(userId: string): Promise<string | null> {
    let r = this.records.get(recordKey.profile(userId)) as SignedRecord<'profile'> | undefined;
    if (!r) {
      await this.fetchProfiles([userId]);
      r = this.records.get(recordKey.profile(userId)) as SignedRecord<'profile'> | undefined;
    }
    return r?.body.encKey ?? null;
  }

  isAllowedPeer(sessionId: string, userId: string): boolean {
    const scope = parseSessionId(sessionId);
    if (!scope) return false;
    if (scope.kind === 'dm') {
      if (!scope.users.includes(userId)) return false;
      return !this.state.friends.blocked.includes(userId);
    }
    return isSpaceMember(this.records, scope.spaceId, userId);
  }

  private historyChannels(sessionId: string): string[] {
    const scope = parseSessionId(sessionId);
    if (!scope) return [];
    if (scope.kind === 'dm') return [sessionId];
    if (scope.kind === 'space') {
      return (this.state.spaces[scope.spaceId]?.channels ?? []).filter((c) => c.kind === 'text').map((c) => c.id);
    }
    return [];
  }

  private async onSessionInvite(sessionId: string, from: string) {
    const scope = parseSessionId(sessionId);
    if (!scope || scope.kind !== 'dm' || !scope.users.includes(this.userId)) return;
    if (this.state.friends.blocked.includes(from)) return;
    this.addDm(from);
    const session = this.ensureSession(sessionId);
    if (!session.state) await session.join().catch(() => {});
  }

  private addDm(userId: string) {
    if (this.state.dms.includes(userId)) return;
    const dms = [userId, ...this.state.dms];
    this.store.set({ dms });
    void this.platform.kv.set('dms', dms);
    void this.fetchProfiles([userId]).catch(() => {});
  }

  /** Opens (or re-opens) a direct conversation. Returns its channel id. */
  async openDm(userId: string): Promise<string> {
    const sessionId = sessionIds.dm(this.userId, userId);
    this.addDm(userId);
    const session = this.ensureSession(sessionId);
    if (!session.state) await session.join().catch((err) => this.reportError(`Could not open conversation: ${err.message}`));
    return sessionId;
  }

  async closeDm(userId: string) {
    const sessionId = sessionIds.dm(this.userId, userId);
    if (this.state.voiceSession === sessionId) await this.leaveVoice();
    await this.sessions.get(sessionId)?.leave();
    this.sessions.delete(sessionId);
    const dms = this.state.dms.filter((d) => d !== userId);
    this.store.set({ dms });
    await this.platform.kv.set('dms', dms);
  }

  // ===========================================================================
  // Chat
  // ===========================================================================

  /** Session that carries a channel's messages. */
  sessionOfChannel(channel: string): string | null {
    if (channel.startsWith('dm:')) return channel;
    for (const space of Object.values(this.state.spaces)) {
      if (space.channels.some((c) => c.id === channel)) return sessionIds.space(space.id);
    }
    return null;
  }

  async openChannel(channel: string) {
    this.store.set((s) => ({ activeChannel: channel, unread: { ...s.unread, [channel]: 0 } }));
    if (!this.state.messages[channel]) {
      const page = await this.platform.messages.page(channel, { limit: 100 });
      this.store.set((s) => ({ messages: { ...s.messages, [channel]: foldEdits(page) } }));
    }
  }

  async loadOlder(channel: string): Promise<boolean> {
    const current = this.state.messages[channel] ?? [];
    const before = current[0]?.ts;
    const page = await this.platform.messages.page(channel, { before, limit: 100 });
    if (page.length === 0) return false;
    this.store.set((s) => ({ messages: { ...s.messages, [channel]: foldEdits([...page, ...(s.messages[channel] ?? [])]) } }));
    return true;
  }

  closeChannel() {
    this.store.set({ activeChannel: null });
  }

  async sendMessage(channel: string, body: string, opts: { replyTo?: string; edits?: string; deleted?: boolean } = {}) {
    const text = body.trim();
    if (!text && !opts.deleted) return;
    if (text.length > LIMITS.messageMaxChars) throw new Error(`Messages are limited to ${LIMITS.messageMaxChars} characters`);
    const sessionId = this.sessionOfChannel(channel);
    if (!sessionId) throw new Error('unknown channel');
    const message = createChatMessage(this.identity!, { ch: channel, body: text, ...opts });
    await this.platform.messages.put(message);
    const session = this.sessions.get(sessionId);
    const delivered = !!session?.connected && session.peers.size > 0 && session.sendGroup({ type: 'message', message });
    this.addToTimeline(channel, { ...message, pending: !delivered });
    this.emit('message', { channel, message, mine: true });
  }

  editMessage(channel: string, id: string, body: string) {
    return this.sendMessage(channel, body, { edits: id });
  }

  deleteMessage(channel: string, id: string) {
    return this.sendMessage(channel, '', { edits: id, deleted: true });
  }

  sendTyping(channel: string) {
    const sessionId = this.sessionOfChannel(channel);
    if (sessionId) this.sessions.get(sessionId)?.sendGroup({ type: 'typing', ch: channel });
  }

  private async acceptMessage(sessionId: string, message: ChatMessage): Promise<boolean> {
    if (!verifyChatMessage(message)) return false;
    if (!this.historyChannels(sessionId).includes(message.ch)) return false;
    if (message.author !== this.userId && !this.isAllowedPeer(sessionId, message.author)) return false;
    if (message.ts > Date.now() + 5 * 60_000) return false;
    const fresh = await this.platform.messages.put(message);
    if (!fresh) return false;
    this.addToTimeline(message.ch, message);
    const mine = message.author === this.userId;
    if (!mine && this.state.activeChannel !== message.ch) {
      this.store.set((s) => ({ unread: { ...s.unread, [message.ch]: (s.unread[message.ch] ?? 0) + 1 } }));
    }
    this.store.set((s) => {
      const typing = s.typing[message.ch];
      if (!typing?.[message.author]) return {};
      const { [message.author]: _, ...rest } = typing;
      return { typing: { ...s.typing, [message.ch]: rest } };
    });
    this.emit('message', { channel: message.ch, message, mine });
    return true;
  }

  private addToTimeline(channel: string, message: MessageView) {
    this.store.set((s) => {
      const list = s.messages[channel];
      if (!list) return {};
      return { messages: { ...s.messages, [channel]: foldEdits([...list.filter((m) => m.id !== message.id), message]) } };
    });
  }

  // ===========================================================================
  // Voice
  // ===========================================================================

  async joinVoice(spaceId: string, channelId: string) {
    return this.joinVoiceSession(sessionIds.voice(spaceId, channelId));
  }

  /** Voice call inside a DM: joins the call and rings the other side. */
  async callDm(userId: string) {
    const sessionId = await this.openDm(userId);
    const answering = this.state.incomingCall?.sessionId === sessionId;
    await this.joinVoiceSession(sessionId);
    if (answering) {
      this.store.set({ incomingCall: null });
      this.sendCallSignal(sessionId, 'accept');
      return;
    }
    this.store.set({ outgoingCall: { sessionId, to: userId, at: Date.now() } });
    this.ringLoop(sessionId);
  }

  private ringTimer?: ReturnType<typeof setInterval>;

  private ringLoop(sessionId: string) {
    clearInterval(this.ringTimer);
    const started = Date.now();
    const ring = () => {
      const out = this.state.outgoingCall;
      if (!out || out.sessionId !== sessionId || Date.now() - started > 45_000) {
        clearInterval(this.ringTimer);
        if (out?.sessionId === sessionId) this.store.set({ outgoingCall: null });
        return;
      }
      this.sendCallSignal(sessionId, 'ring');
    };
    ring();
    this.ringTimer = setInterval(ring, 2500);
  }

  private sendCallSignal(sessionId: string, action: 'ring' | 'accept' | 'decline' | 'end') {
    this.sessions.get(sessionId)?.sendGroup({ type: 'call', action });
  }

  declineCall() {
    const call = this.state.incomingCall;
    if (!call) return;
    this.store.set({ incomingCall: null });
    this.sendCallSignal(call.sessionId, 'decline');
  }

  private onCallSignal(sessionId: string, from: string, action: 'ring' | 'accept' | 'decline' | 'end') {
    if (from === this.userId) return;
    if (action === 'ring') {
      if (this.state.voiceSession === sessionId) {
        this.sendCallSignal(sessionId, 'accept');
        return;
      }
      if (!this.state.incomingCall) this.store.set({ incomingCall: { sessionId, from, at: Date.now() } });
    } else if (action === 'accept') {
      if (this.state.outgoingCall?.sessionId === sessionId) this.store.set({ outgoingCall: null });
    } else if (action === 'decline') {
      if (this.state.outgoingCall?.sessionId === sessionId) {
        this.store.set({ outgoingCall: null });
        this.reportError('Call declined');
        void this.leaveVoice();
      }
    } else if (action === 'end') {
      if (this.state.incomingCall?.sessionId === sessionId) this.store.set({ incomingCall: null });
    }
  }

  private async joinVoiceSession(sessionId: string) {
    const engine = this.voiceEngine;
    if (!engine) throw new Error('Voice is not available on this device');
    if (this.state.voiceSession && this.state.voiceSession !== sessionId) await this.leaveVoice();
    await engine.start();
    this.store.set({ voiceSession: sessionId });
    let session = this.sessions.get(sessionId);
    if (session && sessionId.startsWith('dm:') && !session.isVoice) {
      // Upgrade the DM's text-only session to one with audio.
      await session.leave();
      this.sessions.delete(sessionId);
      session = undefined;
    }
    session = session ?? this.ensureSession(sessionId);
    session.isVoice = true;
    session.setVoiceState(this.state.muted, this.state.deafened);
    await session.join();
  }

  async leaveVoice() {
    const sessionId = this.state.voiceSession;
    if (!sessionId) return;
    if (this.state.outgoingCall?.sessionId === sessionId) {
      this.store.set({ outgoingCall: null });
      this.sendCallSignal(sessionId, 'end');
    }
    this.store.set({ voiceSession: null });
    const session = this.sessions.get(sessionId);
    this.voiceEngine?.stopSession(sessionId);
    if (sessionId.startsWith('dm:')) {
      // Keep the DM open for text.
      await session?.leave();
      this.sessions.delete(sessionId);
      const s = this.ensureSession(sessionId);
      await s.join().catch(() => {});
    } else {
      await session?.leave();
      this.sessions.delete(sessionId);
      this.store.set((s) => {
        const { [sessionId]: _, ...rest } = s.sessions;
        return { sessions: rest };
      });
    }
    if (!this.state.voiceSession) this.voiceEngine?.stop();
  }

  setMuted(muted: boolean) {
    this.store.set({ muted });
    this.voiceEngine?.setMuted(muted);
    this.pushVoiceState();
  }

  setDeafened(deafened: boolean) {
    // Deafening also mutes, as users expect from Discord/TeamSpeak.
    const muted = deafened ? true : this.state.muted;
    this.store.set({ deafened, muted });
    this.voiceEngine?.setMuted(muted);
    this.voiceEngine?.setDeafened(deafened);
    this.pushVoiceState();
  }

  private pushVoiceState() {
    const id = this.state.voiceSession;
    if (id) this.sessions.get(id)?.setVoiceState(this.state.muted, this.state.deafened);
  }

  async shutdown() {
    await this.leaveVoice().catch(() => {});
    for (const s of this.sessions.values()) await s.leave().catch(() => {});
    this.link?.stop();
  }
}

/** Applies edit/delete messages onto the originals they reference. */
export function foldEdits(messages: MessageView[]): MessageView[] {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const byId = new Map<string, MessageView>();
  const out: MessageView[] = [];
  for (const m of sorted) {
    if (m.edits) {
      const original = byId.get(m.edits);
      if (original && original.author === m.author) {
        const updated: MessageView = { ...original, body: m.deleted ? '' : m.body, edited: !m.deleted, deleted: m.deleted };
        byId.set(original.id, updated);
        out[out.indexOf(original)] = updated;
      }
      continue;
    }
    byId.set(m.id, m);
    out.push(m);
  }
  return out;
}
