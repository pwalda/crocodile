import { Coordinator, type CoordinatorConfig } from '@crocodile/coordinator';
import {
  createIdentity,
  createPrekey,
  inviteCommitment,
  randomDeviceId,
  randomId,
  signRecord,
  spaceIdFor,
  type Identity,
} from '@crocodile/crypto';
import {
  peerIds,
  recordKey,
  type HostCaps,
  type Platform,
  type SignedRecord,
} from '@crocodile/protocol';
import { CoordinatorConnection } from '@crocodile/client-core';

export async function startCoordinator(overrides: Partial<CoordinatorConfig> = {}) {
  const c = new Coordinator({
    name: overrides.name ?? `test-${randomId(3)}`,
    host: '127.0.0.1',
    port: 0,
    storage: 'memory',
    stunPort: null,
    announce: false,
    logLevel: 'warn',
    ...overrides,
  });
  return c.start();
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 5000,
  label = 'condition',
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface TestUser {
  identity: Identity;
  conn: CoordinatorConnection;
  events: { ev: string; d: unknown }[];
}

export async function connectUser(
  server: Coordinator,
  identity = createIdentity(),
  username = `user${randomId(2)}`,
  deviceId = randomDeviceId(),
  /** What the device's record says it is; `false` leaves the device without a record. */
  device: Platform | false = 'bot',
): Promise<TestUser> {
  const conn = await CoordinatorConnection.connect({
    url: server.url,
    identity,
    deviceId,
    platform: 'bot',
    version: 'test',
  });
  const events: TestUser['events'] = [];
  for (const ev of [
    'record',
    'presence',
    'session',
    'session_renew',
    'signal',
    'voice',
    'replaced',
    'session_closed',
    'relay_expired',
    'mail',
  ] as const) {
    conn.on(ev, (d) => events.push({ ev, d }));
  }
  const profile = signRecord(identity, 'profile', recordKey.profile(identity.userId), {
    username,
    encKey: identity.encPublicKey,
  });
  const res = await conn.request('records.put', { record: profile });
  if (!res.accepted) throw new Error(`profile rejected: ${res.reason}`);
  // A real client publishes its device record as soon as it is connected.
  if (device) await registerDevice({ identity, conn }, device);
  return { identity, conn, events };
}

/** Publishes the record of the device a connection signed in as (`revoked` withdraws it for good). */
export async function registerDevice(
  user: Pick<TestUser, 'identity' | 'conn'>,
  platform: Platform = 'bot',
  revoked = false,
  version?: number,
) {
  const { identity } = user;
  const deviceId = peerIds.device(user.conn.peer);
  const key = recordKey.device(identity.userId, deviceId);
  const body = {
    userId: identity.userId,
    deviceId,
    name: 'test',
    platform,
    prekey: createPrekey().bundle,
    ...(revoked ? { revoked: true } : {}),
  };
  expectAccepted(
    await user.conn.request('records.put', {
      record: signRecord(identity, 'device', key, body, version),
    }),
  );
}

/**
 * What an app does when the server that keeps a room changes: it signs a new join when asked.
 * `said` is what it says of itself in each.
 */
export function answerRenewals(user: Pick<TestUser, 'conn'>, said: HostCaps) {
  user.conn.on('session_renew', ({ sessionId }) => {
    void user.conn.request('session.join', { sessionId, caps: said }).catch(() => {});
  });
}

export async function createSpace(user: TestUser, name = 'Swamp') {
  const nonce = randomId();
  const spaceId = spaceIdFor(user.identity.publicKey, nonce);
  const text = randomId();
  const voice = randomId();
  const code = randomId(16);
  const space = signRecord(user.identity, 'space', recordKey.space(spaceId), {
    name,
    owner: user.identity.userId,
    nonce,
    admins: [],
    bans: [],
    publicInvite: inviteCommitment(spaceId, code),
    channels: [
      { id: text, name: 'general', kind: 'text' },
      { id: voice, name: 'Lounge', kind: 'voice' },
    ],
  });
  expectAccepted(await user.conn.request('records.put', { record: space }));
  const member = signRecord(
    user.identity,
    'member',
    recordKey.member(spaceId, user.identity.userId),
    {
      spaceId,
      userId: user.identity.userId,
    },
  );
  expectAccepted(await user.conn.request('records.put', { record: member }));
  const invite = signRecord(user.identity, 'invite', recordKey.invite(code), {
    spaceId,
    code,
    expiresAt: Date.now() + 7 * 24 * 3600_000,
  });
  expectAccepted(await user.conn.request('records.put', { record: invite }));
  return { spaceId, textChannel: text, voiceChannel: voice, code, space };
}

export async function joinSpace(user: TestUser, spaceId: string, code: string) {
  const member = signRecord(
    user.identity,
    'member',
    recordKey.member(spaceId, user.identity.userId),
    {
      spaceId,
      userId: user.identity.userId,
      inviteCode: code,
    },
  );
  expectAccepted(await user.conn.request('records.put', { record: member }));
}

export function expectAccepted(res: { accepted: boolean; reason?: string }) {
  if (!res.accepted) throw new Error(`record rejected: ${res.reason}`);
}

export const caps = (overrides: Partial<HostCaps> = {}): HostCaps => ({
  canHost: true,
  platform: 'desktop',
  nat: 'cone',
  uplinkKbps: 10_000,
  cpuCores: 8,
  ...overrides,
});

export function lastSession(user: TestUser, sessionId: string) {
  const ev = [...user.events]
    .reverse()
    .find((e) => e.ev === 'session' && (e.d as { state: { id: string } }).state.id === sessionId);
  return (ev?.d as { state: import('@crocodile/protocol').SessionState } | undefined)?.state;
}

export type { SignedRecord };

/**
 * A hostile mesh peer: the authenticated link from `from` to the server
 * `toId`, to which a test can write any frame, sealed like the real ones.
 */
export function meshLinkTo(from: Coordinator, toId: string) {
  type Internals = {
    links: Map<string, { ws: { readyState: number } }>;
    send(link: unknown, frame: unknown): boolean;
  };
  const mesh = from.mesh as unknown as Internals;
  const link = mesh.links.get(toId);
  if (!link) throw new Error(`no mesh link to ${toId}`);
  return {
    send: (frame: unknown) => mesh.send(link, frame),
    get open() {
      return link.ws.readyState === 1;
    },
  };
}
