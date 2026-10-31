import {
  isSpaceMember,
  keyMatchesUserId,
  randomId,
  sign,
  verifyPayload,
  verifySessionOp,
} from '@crocodile/crypto';
import {
  DEFAULT_RELAY_SLOTS,
  LIMITS,
  joinOp,
  SIG_DOMAIN,
  parseSessionId,
  peerIds,
  recordKey,
  voiceSigned,
  type FedSessionOp,
  type FedVoice,
  type HostCaps,
  type SessionOp,
  type SessionOpProof,
  type SessionState,
  type SessionHint,
  type SignedSessionOp,
  type SignedRecord,
  type VoiceOccupancy,
} from '@crocodile/protocol';
import type { Coordinator } from './coordinator';
import { elect, rendezvousOwner } from './election';
import { RpcFailure } from './util';
import type { ClientHandle } from './presence';

interface OwnedSession {
  state: SessionState;
  memberServer: Map<string, string>;
  penalties: Map<string, number>;
  /** Devices that have said the host is unreachable, with their user (one vote a person). */
  reports: Map<string, string>;
  /** What each member's device signed for: its key, its join (`since`) and the last count of an update. */
  signed: Map<string, { key: string; since: number; n: number }>;
  /** Host adopted from a hint whose member has not re-joined yet. */
  pendingHostUntil: number;
  /** Until when members that have been in the room before (a new owner is putting it together) may say what they saw. */
  rebuildUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** The owner did not answer in time: it may have done what it was asked all the same. */
export class OwnerSilent extends RpcFailure {
  constructor(message = 'session owner did not respond') {
    super('unavailable', message);
  }
}

class Refused extends Error {
  constructor(
    readonly code: RpcFailure['code'],
    message: string,
  ) {
    super(message);
  }
}

const PENDING_HOST_GRACE_MS = 4000;
/** How long after a room is made its members' devices may still say what they saw of it (they are asked at once; some are slower). */
const REBUILD_MS = 10_000;
const HOST_PENALTY_MS = 60_000;
const OP_TIMEOUT_MS = 8000;
/** How far the time on a signed join may be from ours (as for mailbox proofs). */
const SESSION_OP_SKEW_MS = 5 * 60_000;
/** A device asked to sign a new join (the room's server changed) has this long to give one that is taken (the call goes on in the meantime). */
const RENEW_TIMEOUT_MS = 30_000;
/** A join of that kind that was not taken (the new owner may not be reachable yet) is asked for again this soon. */
const RENEW_RETRY_MS = 1000;
/** How often the record of which joins were taken is cleaned of those too old to be replayed. */
const JOIN_SWEEP_MS = 60_000;
export const UNSIGNED = 'session operations must be signed (is the app up to date?)';
export const NOT_RECENT = 'that join is not recent: is the time on this device right?';
const MEMBER_RECONNECT_GRACE_MS = 10_000;
/**
 * The owner repeats what it says about an occupied room this often, and a
 * server believes an announcement for this long: an old one that someone
 * replays does not bring a long-empty room back.
 */
const VOICE_REFRESH_MS = 5 * 60_000;
const VOICE_MAX_AGE_MS = 15 * 60_000;
/** An announcement dated further ahead than this is refused. */
const VOICE_AHEAD_MS = 5 * 60_000;
/**
 * How long an operation from a server waits for news that the member is connected
 * to it (the news may still be on its way), and how many may wait at once.
 */
const HOSTING_GRACE_MS = 1500;
const HOSTING_WAITERS_MAX = 200;
/** Whether a device's record says it was removed from the account. */
const isRemoved = (record: SignedRecord<'device'> | null) => record?.body.revoked === true;

export const DEVICE_REMOVED = 'that device was removed from the account';
const DEVICE_UNKNOWN = 'no record of that device on the account was found';
/** How many may wait at once for the record of a device that has only just been published. */
const DEVICE_WAITERS_MAX = 100;

/** The key of a device's record. */
const deviceKey = (peer: string) => recordKey.device(peerIds.user(peer), peerIds.device(peer));

/** How often an owner asks again whether the devices in its rooms have been removed. */
const DEVICE_RECHECK_MS = 60_000;
/** A device record not found for a server that vouches for it is looked for this often, this far apart. */
const DEVICE_LOOKUPS = 3;
const DEVICE_LOOKUP_WAIT_MS = 300;
/** A new owner adopts the epoch a member saw; no honest session has changed host this often. */
const HINT_EPOCH_MAX = 1_000_000;

/**
 * Sessions and host election.
 *
 * Each session is owned by exactly one coordination server, chosen by
 * rendezvous hashing over the live mesh. Members' own servers keep a registry
 * of which local clients are in which session and forward operations to the
 * owner; when the mesh changes and a session gets a new owner, the member
 * servers ask their members for a new join (each carrying the host its device
 * last saw) so the new owner rebuilds identical state without disturbing the call.
 */
export class SessionService {
  /** sessionId -> local peer id -> caps */
  private local = new Map<string, Map<string, HostCaps>>();
  private lastOwner = new Map<string, string>();
  private owned = new Map<string, OwnedSession>();
  private rechecking = false;
  /** A join of ours being looked into, by room and device; a leave in the meantime cancels it. */
  private joining = new Map<string, { pending: number; leaves: number }>();
  /** The latest operation of a device waiting to be queued, by room and device. */
  private gates = new Map<string, Promise<void>>();
  /** `frame` is what the owner signed, kept to hand on as it was (none if we made the entry up). */
  private occupancy = new Map<string, { occ: VoiceOccupancy; owner: string; frame?: FedVoice }>();
  private pendingOps = new Map<
    string,
    {
      server: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private voiceRefresh: ReturnType<typeof setInterval>;
  private deviceRecheck: ReturnType<typeof setInterval>;
  private joinSweep: ReturnType<typeof setInterval>;
  /**
   * The time (`at`) of the last join signed for each device in each room that we own, for each
   * server it joined from, also after it has left: the same join is not taken twice. Only those that could still pass for recent are kept.
   */
  private joinedAt = new Map<string, number>();
  /** Devices asked to sign a new join, by room and device: what ends the wait, and when. */
  private renewing = new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: number }>();
  private renewTimeoutMs = RENEW_TIMEOUT_MS;
  private renewRetryMs = RENEW_RETRY_MS;

  constructor(private readonly hub: Coordinator) {
    this.voiceRefresh = setInterval(() => this.refreshVoice(), VOICE_REFRESH_MS);
    this.voiceRefresh.unref?.();
    this.deviceRecheck = setInterval(
      () =>
        void this.recheckDevices().catch((err) =>
          this.hub.log.warn('device recheck failed', { err: String(err) }),
        ),
      DEVICE_RECHECK_MS,
    );
    this.deviceRecheck.unref?.();
    this.joinSweep = setInterval(() => {
      const oldest = Date.now() - 2 * SESSION_OP_SKEW_MS;
      for (const [key, at] of this.joinedAt) if (at < oldest) this.joinedAt.delete(key);
    }, JOIN_SWEEP_MS);
    this.joinSweep.unref?.();
  }

  get selfId() {
    return this.hub.info.id;
  }

  liveServers(): string[] {
    return this.hub.membership.liveIds();
  }

  ownerOf(sessionId: string): string {
    return rendezvousOwner(sessionId, this.liveServers());
  }

  // -------------------------------------------------------------------------
  // What a device signed
  // -------------------------------------------------------------------------

  /** What can be told of a proof without the key: that it is there, for this server, and a join recent. */
  private checkProofIsFor(
    server: string,
    op: Exclude<SessionOp, { op: 'leave' }>,
    proof: SessionOpProof | undefined,
  ): asserts proof is SessionOpProof {
    if (!proof) throw new RpcFailure('bad_request', UNSIGNED);
    if (proof.server !== server) throw new RpcFailure('forbidden', 'signed for another server');
    if (op.op === 'join' && Math.abs(Date.now() - proof.at) > SESSION_OP_SKEW_MS)
      throw new RpcFailure('forbidden', NOT_RECENT);
  }

  /**
   * Whether `proof` is the device's own signature on this operation, made for `server` (the
   * one that sent it to us), with the key of its account. A join must also be recent. What
   * the operation is compared with (the join it belongs to, the count) is up to the owner.
   */
  private checkProof(
    key: string,
    sessionId: string,
    peer: string,
    server: string,
    op: Exclude<SessionOp, { op: 'leave' }>,
    proof: SessionOpProof | undefined,
  ) {
    this.checkProofIsFor(server, op, proof);
    // What a server must set (the kind of device) is not what was signed; the hint is, so a server can neither add one nor change it.
    const signed: SignedSessionOp =
      op.op === 'report'
        ? { op: 'report', epoch: op.epoch, issue: op.issue }
        : op.op === 'join'
          ? joinOp(op.caps, op.hint)
          : { op: 'update', caps: op.caps };
    if (!verifySessionOp(key, sessionId, peer, signed, proof))
      throw new RpcFailure('forbidden', 'the signature on that operation is not valid');
  }

  // -------------------------------------------------------------------------
  // Client-facing operations (called on the member's own server)
  // -------------------------------------------------------------------------

  async checkAccess(userId: string, sessionId: string) {
    const scope = parseSessionId(sessionId);
    if (!scope) throw new RpcFailure('bad_request', 'invalid session id');
    if (scope.kind === 'space' || scope.kind === 'voice') {
      // The space's records may live on other servers.
      const byKey = await this.hub.dist.membershipRecords([scope.spaceId], userId);
      if (!isSpaceMember({ get: (k) => byKey.get(k) }, scope.spaceId, userId))
        throw new RpcFailure('forbidden', 'not a member of this space');
      if (scope.kind === 'voice') {
        const space = byKey.get(`space:${scope.spaceId}`) as SignedRecord<'space'>;
        const channel = space.body.channels.find((c) => c.id === scope.channelId);
        if (!channel || channel.kind !== 'voice')
          throw new RpcFailure('not_found', 'no such voice channel');
      }
      return;
    }
    const [a, b] = scope.users;
    if (userId !== a && userId !== b)
      throw new RpcFailure('forbidden', 'not part of this conversation');
    // Blocks are enforced by the blocking user's apps: block lists are sealed,
    // so servers can't (and shouldn't) know who blocked whom.
  }

  /** The record of a device (a removed one included), or null if none can be found. */
  private async findDevice(peer: string): Promise<SignedRecord<'device'> | null> {
    const key = deviceKey(peer);
    const [record] = await this.hub.dist.get([key]);
    if (!record || record.key !== key || record.kind !== 'device') return null;
    const device = record as SignedRecord<'device'>;
    // Belongs to this very device of this very account.
    return device.body.userId === peerIds.user(peer) &&
      device.body.deviceId === peerIds.device(peer)
      ? device
      : null;
  }

  /** Looks for a record that is not there yet for a moment; devices waited for share the wait. */
  private waitForDevice(peer: string): Promise<SignedRecord<'device'> | null> {
    const running = this.waiting.get(peer);
    if (running) return running;
    if (this.waiting.size >= DEVICE_WAITERS_MAX) return Promise.resolve(null);
    const wait = (async () => {
      for (let i = 0; i < DEVICE_LOOKUPS; i++) {
        await new Promise((r) => setTimeout(r, DEVICE_LOOKUP_WAIT_MS));
        // A failed try is one try spent, not the end of the wait.
        const record = await this.findDevice(peer).catch(() => null);
        if (record) return record;
      }
      return null;
    })().finally(() => this.waiting.delete(peer));
    this.waiting.set(peer, wait);
    return wait;
  }

  /**
   * The record of a device that is on its account and has not been removed from it (or that
   * it has, which is told apart from there being none). With `patient`, a record that is not
   * there is looked for again for a moment: one just published may not have reached the
   * servers that hold it.
   */
  private async lookupDevice(
    peer: string,
    patient = false,
  ): Promise<{ device: SignedRecord<'device'> | null; removed: boolean }> {
    let record = await this.findDevice(peer);
    // Few may wait at once, and a device waits once however many rooms it is joining.
    if (patient && !record) record = await this.waitForDevice(peer);
    const removed = isRemoved(record);
    return { device: removed ? null : record, removed };
  }

  /**
   * What the server takes from a device of ours that joins or updates: it must have a record
   * on its account (the sign-in names a device but proves only the account), and what kind of
   * device it is comes from that record, not from what it says. One found to have been
   * removed also leaves the room at once.
   */
  private async vouchOrDrop(peer: string, sessionId: string, caps: HostCaps, patient = false) {
    let found: Awaited<ReturnType<SessionService['lookupDevice']>>;
    try {
      found = await this.lookupDevice(peer, patient);
    } catch {
      throw new RpcFailure('unavailable', 'could not look up that device');
    }
    if (found.device)
      return { caps: { ...caps, platform: found.device.body.platform }, device: found.device };
    if (found.removed) {
      void this.leave(peer, sessionId);
      throw new RpcFailure('forbidden', DEVICE_REMOVED);
    }
    // Not found is not the same as removed: the servers that hold it may not be reachable.
    throw new RpcFailure('unavailable', DEVICE_UNKNOWN);
  }

  /**
   * Whether a server may add this device: it is connected to it, and it has a record on its
   * account (returned). Both are waited for briefly, outside the room's queue and within a cap
   * on those waiting (one for each wait), so that devices made up in numbers cannot hold the
   * room up.
   */
  private async admit(
    server: string,
    peer: string,
    sessionId: string,
    op: FedSessionOp['op'],
  ): Promise<
    | { refused: string; code: RpcFailure['code'] }
    | { device: SignedRecord<'device'>; hint?: SessionHint }
  > {
    try {
      // The cheap refusals first: a device made up for somebody who may not be here costs no wait.
      await this.checkAccess(peerIds.user(peer), sessionId).catch((err) => {
        // Told not to by the records is final; failing to find out is not.
        throw err instanceof RpcFailure ? new Refused(err.code, err.message) : err;
      });
      if (!(await this.connectedTo(server, peer)))
        return {
          refused: 'that device is not connected to the sending server',
          code: 'unavailable',
        };
      const { device, removed } = await this.lookupDevice(peer, true);
      if (!device)
        return removed
          ? { refused: DEVICE_REMOVED, code: 'forbidden' }
          : { refused: DEVICE_UNKNOWN, code: 'unavailable' };
      // What a hint names is looked into here too, not in the room's queue.
      const hint =
        op.op === 'join' && op.hint && this.hintMatters(sessionId, op.hint)
          ? await this.hintAllowed(sessionId, op.hint)
          : null;
      return { device, ...(hint ? { hint } : {}) };
    } catch (err) {
      if (err instanceof Refused) return { refused: err.message, code: err.code };
      return { refused: 'could not look up that device', code: 'unavailable' };
    }
  }

  /**
   * Takes out of the rooms the devices that have been removed from their accounts: of the
   * rooms this server owns (whichever server the device is on), and of those its own clients
   * are in (so that they can no longer signal or ask for a relay). A record that cannot be
   * found now says nothing (it was there at the join), so only a removal counts.
   */
  async recheckDevices() {
    // A slow lookup is not started over by the next tick.
    if (this.rechecking) return;
    this.rechecking = true;
    try {
      const owned = [...this.owned.values()];
      const mine = [...this.local].map(([sessionId, members]) => ({
        sessionId,
        peers: [...members.keys()],
      }));
      const keys = new Set<string>();
      for (const s of owned) for (const m of s.state.members) keys.add(deviceKey(m.peer));
      for (const { peers } of mine) for (const peer of peers) keys.add(deviceKey(peer));
      if (keys.size === 0) return;
      let records: SignedRecord[];
      try {
        // One lookup for every room, each device once.
        records = await this.hub.dist.get([...keys]);
      } catch (err) {
        this.hub.log.debug('could not look up devices', { err: String(err) });
        return;
      }
      const removed = new Set(
        records
          .filter((r) => r.kind === 'device' && isRemoved(r as SignedRecord<'device'>))
          .map((r) => r.key),
      );
      if (removed.size === 0) return;
      for (const s of owned) {
        if (this.owned.get(s.state.id) !== s) continue;
        for (const m of [...s.state.members])
          if (removed.has(deviceKey(m.peer))) this.removeMember(s, m.peer);
      }
      // Together: each waits for its room's owner, who may be slow.
      await Promise.allSettled(
        mine.flatMap(({ sessionId, peers }) =>
          peers.filter((p) => removed.has(deviceKey(p))).map((p) => this.leave(p, sessionId)),
        ),
      );
    } finally {
      this.rechecking = false;
    }
  }

  inSession(peer: string, sessionId: string) {
    return this.local.get(sessionId)?.has(peer) ?? false;
  }

  async join(
    client: ClientHandle,
    sessionId: string,
    caps: HostCaps,
    hint: SessionHint | undefined,
    proof: SessionOpProof | undefined,
  ): Promise<SessionState> {
    const joinKey = `${sessionId}|${client.peer}`;
    // The device's own signature, for us, before anything is spent on it.
    this.checkProof(
      client.publicKey,
      sessionId,
      client.peer,
      this.selfId,
      joinOp(caps, hint),
      proof,
    );
    // It answered, if it was asked to sign again (the wait starts again if what it sent is not taken).
    const renewal = this.renewing.get(joinKey);
    clearTimeout(renewal?.timer);
    const wait = this.joining.get(joinKey) ?? { pending: 0, leaves: 0 };
    this.joining.set(joinKey, wait);
    wait.pending += 1;
    const leavesBefore = wait.leaves;
    let vouched: HostCaps;
    let device: SignedRecord<'device'>;
    // What the device says it saw is believed only as far as it can be (the owner looks at it when it is another server).
    let believed: SessionHint | null | undefined;
    try {
      await this.checkAccess(client.userId, sessionId);
      ({ caps: vouched, device } = await this.vouchOrDrop(client.peer, sessionId, caps, true));
      if (hint && this.ownerOf(sessionId) === this.selfId && this.hintMatters(sessionId, hint))
        believed = await this.hintAllowed(sessionId, hint);
    } catch (err) {
      // No longer allowed in (left the space, say): asking again would only be refused again.
      if (renewal && err instanceof RpcFailure && err.code === 'forbidden') {
        this.endRenewal(joinKey);
        this.dropUnrenewed(sessionId, client.peer, false);
      } else this.askAgain(renewal, sessionId, client, err);
      throw err;
    } finally {
      if (--wait.pending === 0 && this.joining.get(joinKey) === wait) this.joining.delete(joinKey);
    }
    // It may have left meanwhile. (Joined again is no matter: both go on, and a join said twice
    // is the same join.)
    // (Either way nobody is left to wait for.)
    if (wait.leaves !== leavesBefore) {
      this.endRenewal(joinKey);
      throw new RpcFailure('not_found', 'left before it joined');
    }
    // It may have gone (or been replaced) while the record was looked up; nothing would remove it later.
    if (!this.hub.presence.localOf(client.userId).includes(client)) {
      this.endRenewal(joinKey);
      throw new RpcFailure('unavailable', 'the connection closed');
    }
    clearTimeout(this.pendingLeaves.get(joinKey));
    this.pendingLeaves.delete(joinKey);
    let members = this.local.get(sessionId);
    if (!members) this.local.set(sessionId, (members = new Map()));
    const before = members.get(client.peer);
    members.set(client.peer, vouched);
    const owner = this.ownerOf(sessionId);
    this.lastOwner.set(sessionId, owner);
    try {
      // What was signed goes on as it was; the owner sets the kind of device from the record itself.
      const state = (await this.submit(
        sessionId,
        client.peer,
        joinOp(caps, hint),
        proof,
        device,
        believed,
      )) as SessionState;
      // Taken by the owner: nothing more to ask of it (unless the owner has changed again meanwhile).
      if (this.lastOwner.get(sessionId) === owner) this.endRenewal(joinKey);
      return state;
    } catch (err) {
      // Refused: the client is told so, and must not be treated as in the room (or as having
      // said what was refused) meanwhile. Not if another join of it has since taken its place.
      // Not when the owner simply did not answer: it may have applied the join.
      const current = this.local.get(sessionId);
      const silent = err instanceof OwnerSilent;
      // A device that is out for good is let go; a refusal of the new owner (which may be behind
      // on the records) is not final for a device that was in the room, while it is asked again.
      const final = err instanceof RpcFailure && err.message === DEVICE_REMOVED;
      const forbidden = err instanceof RpcFailure && err.code === 'forbidden';
      // (The time that stands now: the owner may have changed again, and the device been asked again.)
      const deadline = this.renewing.get(joinKey)?.deadline ?? renewal?.deadline ?? 0;
      const keep = !final && !!renewal && Date.now() < deadline;
      if (!silent && current?.get(client.peer) === vouched) {
        if (before && (!forbidden || keep)) current.set(client.peer, before);
        // (Out because the time it had has gone: it is told, so that it joins again.)
        else if (renewal && before) this.dropUnrenewed(sessionId, client.peer, !final);
        else void this.leave(client.peer, sessionId);
      }
      if (!final) this.askAgain(renewal, sessionId, client, err);
      throw err;
    }
  }

  async update(
    client: ClientHandle,
    sessionId: string,
    caps: HostCaps,
    proof: SessionOpProof | undefined,
  ) {
    const members = this.local.get(sessionId);
    const current = members?.get(client.peer);
    if (!members || !current) throw new RpcFailure('not_found', 'not in session');
    this.checkProof(
      client.publicKey,
      sessionId,
      client.peer,
      this.selfId,
      { op: 'update', caps },
      proof,
    );
    // What kind of device it is was settled by the join; a removed device is found by the recheck.
    const said = { ...caps, platform: current.platform };
    members.set(client.peer, said);
    try {
      await this.submit(sessionId, client.peer, { op: 'update', caps }, proof);
    } catch (err) {
      // Not taken: what we hold is what the owner has (unless it was said again meanwhile, or the
      // owner simply did not answer: it may have applied it).
      if (!(err instanceof OwnerSilent) && members.get(client.peer) === said)
        members.set(client.peer, current);
      throw err;
    }
  }

  async leave(peer: string, sessionId: string) {
    const joining = this.joining.get(`${sessionId}|${peer}`);
    if (joining) joining.leaves += 1;
    clearTimeout(this.renewing.get(`${sessionId}|${peer}`)?.timer);
    this.renewing.delete(`${sessionId}|${peer}`);
    const members = this.local.get(sessionId);
    if (!members?.delete(peer)) return;
    if (members.size === 0) {
      this.local.delete(sessionId);
      this.lastOwner.delete(sessionId);
    }
    // Not signed: the server a device joined from says so when it goes (the device cannot, then).
    await this.submit(sessionId, peer, { op: 'leave' }).catch(() => {});
  }

  async report(
    client: ClientHandle,
    sessionId: string,
    epoch: number,
    proof: SessionOpProof | undefined,
  ) {
    if (!this.inSession(client.peer, sessionId))
      throw new RpcFailure('not_found', 'not in session');
    const op = { op: 'report', epoch, issue: 'host_unreachable' } as const;
    this.checkProof(client.publicKey, sessionId, client.peer, this.selfId, op, proof);
    await this.submit(sessionId, client.peer, op, proof);
  }

  private pendingLeaves = new Map<string, ReturnType<typeof setTimeout>>();
  private orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

  onClientReplaced(peer: string) {
    for (const [sessionId, members] of this.local) {
      if (!members.has(peer)) continue;
      const key = `${sessionId}|${peer}`;
      clearTimeout(this.pendingLeaves.get(key));
      const timer = setTimeout(() => {
        this.pendingLeaves.delete(key);
        void this.leave(peer, sessionId);
      }, 10_000);
      timer.unref?.();
      this.pendingLeaves.set(key, timer);
    }
  }

  onClientGone(peer: string) {
    for (const [sessionId, members] of [...this.local]) {
      if (members.has(peer)) void this.leave(peer, sessionId);
    }
  }

  /** Sessions the given local peer is in (for tests and diagnostics). */
  sessionsOf(peer: string) {
    return [...this.local].filter(([, m]) => m.has(peer)).map(([id]) => id);
  }

  ownedState(sessionId: string): SessionState | undefined {
    return this.owned.get(sessionId)?.state;
  }

  // -------------------------------------------------------------------------
  // Routing to the owner
  // -------------------------------------------------------------------------

  private submit(
    sessionId: string,
    peer: string,
    op: SessionOp,
    proof?: SessionOpProof,
    /** The record of the device, for a join (we have already found it). */
    device?: SignedRecord<'device'>,
    /** What of its hint we found to be believable, for a join we keep ourselves (null: none; not looked into: undefined). */
    hint?: SessionHint | null,
  ): Promise<unknown> {
    const owner = this.ownerOf(sessionId);
    if (owner === this.selfId) {
      try {
        // As if from another server: what was signed is checked, and the kind of device set, all the same.
        const frame: FedSessionOp = {
          t: 'session_op',
          opId: '',
          sessionId,
          peer,
          op,
          ...(proof ? { proof } : {}),
        };
        const run = (believed?: SessionHint | null) =>
          this.runRemoteOp(this.selfId, frame, {
            ...(device ? { device } : {}),
            ...(believed ? { hint: believed } : {}),
          });
        // The room became ours since the join was looked at: the hint has not been looked into yet.
        if (
          hint === undefined &&
          op.op === 'join' &&
          op.hint &&
          this.hintMatters(sessionId, op.hint)
        ) {
          const named = op.hint;
          return this.hintAllowed(sessionId, named).then(run);
        }
        return Promise.resolve(run(hint));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const opId = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(opId);
        reject(new OwnerSilent());
      }, OP_TIMEOUT_MS);
      this.pendingOps.set(opId, { server: owner, resolve, reject, timer });
      const sent = this.hub.mesh.sendTo(owner, {
        t: 'session_op',
        opId,
        sessionId,
        peer,
        op,
        ...(proof ? { proof } : {}),
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingOps.delete(opId);
        reject(new RpcFailure('unavailable', 'session owner unreachable'));
      }
    });
  }

  /** Operations on one session are applied one at a time, in the order they arrived. */
  private opChains = new Map<string, Promise<void>>();
  private hostingWaiters = 0;
  /** Devices whose record is being waited for, with the wait. */
  private waiting = new Map<string, Promise<SignedRecord<'device'> | null>>();

  handleRemoteOp(fromServer: string, frame: FedSessionOp) {
    const reply = (res: { ok: unknown } | { err: unknown }) =>
      this.hub.mesh.sendTo(fromServer, { t: 'session_op_res', opId: frame.opId, ...res } as never);
    const fail = (err: unknown) =>
      reply({
        err: {
          code: err instanceof RpcFailure ? err.code : 'internal',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    // Only a join has to be vouched for (by presence and by the device's record): whoever
    // else speaks for a member must be the server it joined from, which `apply` checks. (A
    // member who disconnects is already gone from the presence when its leave arrives.)
    // What a device does is taken in the order it was sent, also while a join is still being
    // looked into (a leave must not pass it); other devices' operations are not held up.
    // A join that is not signed for us, or not recent, costs no look-up of the device.
    if (frame.op.op === 'join') {
      try {
        this.checkProofIsFor(fromServer, frame.op, frame.proof);
      } catch (err) {
        fail(err);
        return;
      }
    }
    const gateKey = `${frame.sessionId}|${frame.peer}`;
    const gate = this.gates.get(gateKey) ?? Promise.resolve();
    type Admitted =
      Awaited<ReturnType<SessionService['admit']>> | { device?: undefined; hint?: undefined };
    const admitted: Promise<Admitted> = gate
      .then(() =>
        frame.op.op === 'join'
          ? this.admit(fromServer, frame.peer, frame.sessionId, frame.op)
          : ({} as Admitted),
      )
      .catch((): Admitted => ({ refused: 'could not look up that device', code: 'unavailable' }));
    const next = admitted.then(
      () => {},
      () => {},
    );
    this.gates.set(gateKey, next);
    void next.then(() => {
      if (this.gates.get(gateKey) === next) this.gates.delete(gateKey);
    });
    void admitted.then((result) => {
      if ('refused' in result) {
        fail(new RpcFailure(result.code, result.refused));
        return;
      }
      const previous = this.opChains.get(frame.sessionId) ?? Promise.resolve();
      const run: Promise<void> = previous.then(async () => {
        try {
          reply({ ok: await this.runRemoteOp(fromServer, frame, result) });
        } catch (err) {
          fail(err);
        }
      });
      this.opChains.set(frame.sessionId, run);
      void run.then(() => {
        if (this.opChains.get(frame.sessionId) === run) this.opChains.delete(frame.sessionId);
      });
    });
  }

  /**
   * Whether the server may add this device to a session: it has told the mesh
   * the device is connected to it. News of a device that has only just connected
   * can still be on its way, so it is waited for briefly.
   */
  private async connectedTo(server: string, peer: string): Promise<boolean> {
    const presence = this.hub.presence;
    if (presence.hosts(server, peer)) return true;
    if (this.hostingWaiters >= HOSTING_WAITERS_MAX) return false;
    this.hostingWaiters += 1;
    try {
      const until = Date.now() + HOSTING_GRACE_MS;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
        if (presence.hosts(server, peer)) return true;
      }
      return false;
    } finally {
      this.hostingWaiters -= 1;
    }
  }

  /**
   * The owner's side of an operation (also of our own members', which come the same way): whoever
   * joins must still be allowed, and so must the host they name; and what the device signed
   * must be its own, for the server that sent it, and the next in line.
   */
  private runRemoteOp(
    fromServer: string,
    frame: FedSessionOp,
    admitted: { device?: SignedRecord<'device'>; hint?: SessionHint },
  ): unknown {
    const { sessionId, peer } = frame;
    const proof = frame.proof as SessionOpProof;
    let op = frame.op;
    // The server a member joined from says when it has gone, as it must (the device cannot then).
    if (op.op === 'leave') return this.apply(sessionId, peer, fromServer, op);
    if (op.op === 'join') {
      // `admit` checked that the account may be in the room, and found the record; a join always comes with it.
      if (!admitted.device) throw new RpcFailure('internal', 'join was not admitted');
      const key = admitted.device.author;
      this.checkProof(key, sessionId, peer, fromServer, op, frame.proof);
      // Per sending server: what it can replay is what was signed for it, and the clocks of two servers differ.
      const joinKey = `${sessionId}|${peer}|${fromServer}`;
      const last = this.joinedAt.get(joinKey);
      if (last !== undefined && proof.at <= last) {
        // The same join said twice, or one overtaken by a later: nothing to do for a member that
        // is in. One that was taken and is out again is not taken a second time.
        const s = this.owned.get(sessionId);
        if (
          s?.memberServer.get(peer) === fromServer &&
          s.state.members.some((m) => m.peer === peer)
        )
          return s.state;
        throw new RpcFailure(
          'forbidden',
          'that join was already used (or the clock of this device went back)',
        );
      }
      op = { ...op, caps: { ...op.caps, platform: admitted.device.body.platform } };
      if (op.hint) {
        const { hint: _named, ...rest } = op;
        op = admitted.hint ? { ...rest, hint: admitted.hint } : rest;
      }
      const state = this.apply(sessionId, peer, fromServer, op);
      this.joinedAt.set(joinKey, proof.at);
      this.owned.get(sessionId)?.signed.set(peer, { key, since: proof.at, n: 0 });
      return state;
    }
    // Only what the server a member joined from says about it is believed.
    const s = this.owned.get(sessionId);
    const member = s?.state.members.find((m) => m.peer === peer);
    const signed = s?.signed.get(peer);
    // (An update or a report of a device the owner does not have in the room: it is told, for it may have to join again.)
    if (!s || !member || !signed || s.memberServer.get(peer) !== fromServer)
      throw new RpcFailure('not_found', 'not in session');
    this.checkProof(signed.key, sessionId, peer, fromServer, op, frame.proof);
    // One of an earlier join of the device is told so (it may have to join again); an older update than one taken is of no account.
    if (proof.since !== signed.since)
      throw new RpcFailure('conflict', 'that is not the join the device has in the session');
    if (op.op === 'update') {
      if (proof.n === undefined || proof.n <= signed.n) return {};
      signed.n = proof.n;
      // What kind of device it is stays what the join found.
      op = { ...op, caps: { ...op.caps, platform: member.caps.platform } };
    }
    return this.apply(sessionId, peer, fromServer, op);
  }

  /**
   * Whether a room takes a hint: only while it is being put together again (a moment after it
   * was made, or a host from an earlier hint still waited for), and only one that is later than
   * what it has. A member of a room that stands cannot move its host by saying what it saw.
   */
  private mayTakeHint(s: OwnedSession, hint: SessionHint, now: number) {
    const together =
      s.state.members.length === 0 || now < s.rebuildUntil || s.pendingHostUntil > now;
    return together && hint.epoch > s.state.epoch;
  }

  /** Whether a hint is worth looking into: the room is not ours yet, or would take it. */
  private hintMatters(sessionId: string, hint: SessionHint) {
    const s = this.owned.get(sessionId);
    return !s || this.mayTakeHint(s, hint, Date.now());
  }

  /**
   * What of a hint is believed: the host it names, and the backup, if they may be in the
   * session as devices that exist (a record not yet found is waited for, as at a join). A
   * backup that does not pass is left out and the host kept; a host that is named and does
   * not pass makes the whole hint worthless (none named is fine: the epoch is kept).
   */
  private async hintAllowed(sessionId: string, hint: SessionHint): Promise<SessionHint | null> {
    if (hint.epoch < 0 || hint.epoch > HINT_EPOCH_MAX) return null;
    const known = async (peer: string | null) => {
      if (!peer) return null;
      try {
        await this.checkAccess(peerIds.user(peer), sessionId);
        return (await this.lookupDevice(peer, true)).device ? peer : null;
      } catch {
        return null;
      }
    };
    const [host, backup] = await Promise.all([known(hint.host), known(hint.backup)]);
    // A room that had no host still has an epoch to keep.
    return host || !hint.host ? { epoch: hint.epoch, host, backup } : null;
  }

  handleRemoteResult(opId: string, ok: unknown, err?: { code: string; message: string }) {
    const pending = this.pendingOps.get(opId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOps.delete(opId);
    if (err) pending.reject(new RpcFailure(err.code as RpcFailure['code'], err.message));
    else pending.resolve(ok);
  }

  // -------------------------------------------------------------------------
  // Owner-side state machine
  // -------------------------------------------------------------------------

  private apply(sessionId: string, peer: string, serverId: string, op: SessionOp): unknown {
    const userId = peerIds.user(peer);
    const scope = parseSessionId(sessionId);
    if (!scope) throw new RpcFailure('bad_request', 'invalid session id');
    const now = Date.now();
    let s = this.owned.get(sessionId);

    if (op.op === 'join') {
      if (!s) {
        s = {
          state: {
            id: sessionId,
            epoch: 0,
            host: null,
            backup: null,
            members: [],
            relaySlots: scope.kind === 'voice' ? DEFAULT_RELAY_SLOTS : scope.kind === 'dm' ? 1 : 0,
            updatedAt: now,
          },
          memberServer: new Map(),
          signed: new Map(),
          penalties: new Map(),
          reports: new Map(),
          pendingHostUntil: 0,
          rebuildUntil: now + REBUILD_MS,
        };
        this.owned.set(sessionId, s);
      }
      if (op.hint && this.mayTakeHint(s, op.hint, now)) {
        s.state.epoch = op.hint.epoch;
        s.state.host = op.hint.host;
        s.state.backup = op.hint.backup;
        s.pendingHostUntil = now + PENDING_HOST_GRACE_MS;
        this.scheduleRecheck(s, PENDING_HOST_GRACE_MS + 50);
      }
      const existing = s.state.members.find((m) => m.peer === peer);
      if (existing) existing.caps = op.caps;
      else {
        if (s.state.members.length >= LIMITS.sessionMembersMax)
          throw new RpcFailure('conflict', 'session is full');
        s.state.members.push({ peer, userId, joinedAt: now, caps: op.caps });
      }
      s.memberServer.set(peer, serverId);
      clearTimeout(this.orphanTimers.get(`${sessionId}|${peer}`));
      this.orphanTimers.delete(`${sessionId}|${peer}`);
      this.recompute(s);
      if (scope.kind === 'dm') {
        const other = scope.users[0] === userId ? scope.users[1] : scope.users[0];
        if (!s.state.members.some((m) => m.userId === other)) {
          this.hub.deliver(other, 'session_invite', { sessionId, from: userId });
        }
      }
      return s.state;
    }

    if (!s) return {};
    const member = s.state.members.find((m) => m.peer === peer);
    // Only the server a member joined from speaks for it afterwards.
    if (member && s.memberServer.get(peer) !== serverId) return {};
    switch (op.op) {
      case 'update':
        if (member) {
          member.caps = op.caps;
          this.recompute(s);
        }
        return {};
      case 'leave':
        this.removeMember(s, peer);
        return {};
      case 'report': {
        // One vote a person, and not against one's own host: more devices are not more people.
        const host = s.state.host;
        if (!member || op.epoch !== s.state.epoch || !host) return {};
        const hostUser = peerIds.user(host);
        if (userId === hostUser) return {};
        s.reports.set(peer, userId);
        const others = new Set(s.state.members.map((m) => m.userId));
        others.delete(hostUser);
        if (new Set(s.reports.values()).size >= Math.max(1, Math.ceil(others.size / 2))) {
          s.penalties.set(host, now + HOST_PENALTY_MS);
          this.hub.log.info('host reported unreachable; failing over', {
            sessionId,
            host,
          });
          this.recompute(s);
        }
        return {};
      }
    }
  }

  private removeMember(s: OwnedSession, peer: string) {
    const before = s.state.members.length;
    s.state.members = s.state.members.filter((m) => m.peer !== peer);
    s.memberServer.delete(peer);
    s.signed.delete(peer);
    s.reports.delete(peer);
    if (s.state.members.length === before) return;
    if (s.state.members.length === 0) {
      this.dropOwned(s.state.id, true);
      return;
    }
    this.recompute(s);
  }

  private dropOwned(sessionId: string, announceEmpty: boolean) {
    const s = this.owned.get(sessionId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.owned.delete(sessionId);
    if (announceEmpty) {
      s.state.members = [];
      s.state.host = null;
      s.state.backup = null;
      this.announceVoice(s.state);
    }
  }

  private scheduleRecheck(s: OwnedSession, delay: number) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = undefined;
      if (this.owned.get(s.state.id) === s) this.recompute(s);
    }, delay);
    s.timer.unref?.();
  }

  private recompute(s: OwnedSession) {
    const now = Date.now();
    const st = s.state;
    const prevHost = st.host;
    const hostIsMember = !!st.host && st.members.some((m) => m.peer === st.host);
    let result: { host: string | null; backup: string | null };
    if (st.host && !hostIsMember && s.pendingHostUntil > now) {
      // The adopted host has not re-joined yet; keep it during the grace period.
      const others = elect({
        sessionId: st.id,
        members: st.members,
        host: null,
        backup: st.backup,
        penalties: s.penalties,
        now,
      });
      result = { host: st.host, backup: others.host === st.host ? others.backup : others.host };
    } else {
      result = elect({
        sessionId: st.id,
        members: st.members,
        host: st.host,
        backup: st.backup,
        penalties: s.penalties,
        now,
      });
    }
    st.host = result.host;
    st.backup = result.backup;
    if (st.host !== prevHost) {
      st.epoch += 1;
      s.reports.clear();
    }
    st.updatedAt = now;
    this.broadcast(s);
    // Re-evaluate when a penalty expires so a recovered peer can serve as backup again.
    const nextPenalty = Math.min(...[...s.penalties.values()].filter((t) => t > now));
    if (Number.isFinite(nextPenalty) && !s.timer) this.scheduleRecheck(s, nextPenalty - now + 10);
  }

  private broadcast(s: OwnedSession) {
    for (const m of s.state.members) {
      // We know each member's server: no need to look it up.
      const server = s.memberServer.get(m.peer);
      const d = { state: s.state };
      if (server && server !== this.selfId) {
        this.hub.mesh.sendTo(server, { t: 'route', to: m.peer, ev: 'session', d });
      } else this.hub.deliverToPeer(m.peer, 'session', d);
    }
    this.announceVoice(s.state);
  }

  // -------------------------------------------------------------------------
  // Voice channel occupancy (flooded, so any server can answer voice.watch)
  // -------------------------------------------------------------------------

  /** sessionId -> when its latest announcement was made (kept after it empties). */
  private voiceAt = new Map<string, number>();
  /** Rooms that emptied in the last hour, so a server that missed it hears it in a snapshot. */
  private emptied = new Map<
    string,
    { occ: VoiceOccupancy; owner: string; at: number; frame?: FedVoice }
  >();
  private voiceSeq = 0;

  private announceVoice(state: SessionState) {
    const scope = parseSessionId(state.id);
    if (!scope || scope.kind !== 'voice') return;
    const occ: VoiceOccupancy = {
      spaceId: scope.spaceId,
      channelId: scope.channelId,
      members: [...new Set(state.members.map((m) => m.userId))],
      host: state.host ? peerIds.user(state.host) : null,
    };
    this.voiceSeq = Math.max(Date.now(), this.voiceSeq + 1);
    const at = this.voiceSeq;
    this.voiceAt.set(state.id, at);
    const parts = { sessionId: state.id, occ, owner: this.selfId, at };
    const frame: FedVoice = {
      t: 'voice',
      ...parts,
      key: this.hub.info.key,
      sig: sign(this.hub.identity, SIG_DOMAIN.voice, voiceSigned(parts)),
    };
    this.setOccupancy(state.id, occ, this.selfId, frame);
    this.hub.mesh.forward(frame);
  }

  /** Say again what we have said about the rooms we own that are occupied. */
  private refreshVoice() {
    for (const s of this.owned.values())
      if (s.state.members.length > 0) this.announceVoice(s.state);
  }

  /**
   * An announcement from another server: signed by the owner of the room, which
   * is the server we also take to own it, and recent. Returns true if it was news.
   */
  applyRemoteVoice(frame: FedVoice): boolean {
    if (frame.owner === this.selfId || typeof frame.at !== 'number') return false;
    const now = Date.now();
    if (!(frame.at <= now + VOICE_AHEAD_MS) || !(frame.at >= now - VOICE_MAX_AGE_MS)) return false;
    if ((this.voiceAt.get(frame.sessionId) ?? 0) >= frame.at) return false;
    const scope = parseSessionId(frame.sessionId);
    if (
      scope?.kind !== 'voice' ||
      scope.spaceId !== frame.occ.spaceId ||
      scope.channelId !== frame.occ.channelId ||
      this.ownerOf(frame.sessionId) !== frame.owner
    )
      return false;
    if (
      !keyMatchesUserId(frame.key, frame.owner) ||
      !verifyPayload(frame.key, SIG_DOMAIN.voice, voiceSigned(frame), frame.sig)
    )
      return false;
    this.voiceAt.set(frame.sessionId, frame.at);
    this.setOccupancy(frame.sessionId, frame.occ, frame.owner, frame);
    return true;
  }

  private setOccupancy(sessionId: string, occ: VoiceOccupancy, owner: string, frame?: FedVoice) {
    if (occ.members.length === 0) {
      this.occupancy.delete(sessionId);
      this.emptied.set(sessionId, { occ, owner, at: Date.now(), frame });
    } else {
      this.occupancy.set(sessionId, { occ, owner, frame });
      this.emptied.delete(sessionId);
    }
    if (this.voiceAt.size > 100_000) {
      for (const id of this.voiceAt.keys()) if (!this.occupancy.has(id)) this.voiceAt.delete(id);
    }
    for (const client of this.hub.presence.localClients()) {
      if (client.voiceWatch.has(occ.spaceId)) client.send('voice', occ);
    }
  }

  voiceSnapshot(spaceIds: string[]): VoiceOccupancy[] {
    const wanted = new Set(spaceIds);
    return [...this.occupancy.values()].map((o) => o.occ).filter((o) => wanted.has(o.spaceId));
  }

  /** Every room we know is occupied, as its owner announced it, for a server that just linked to us. */
  voiceFrames(): FedVoice[] {
    const now = Date.now();
    for (const [id, e] of this.emptied) if (e.at < now - 3600_000) this.emptied.delete(id);
    return [...this.occupancy.values(), ...this.emptied.values()]
      .map((o) => o.frame)
      .filter((f): f is FedVoice => !!f && f.at >= now - VOICE_MAX_AGE_MS);
  }

  // -------------------------------------------------------------------------
  // Mesh membership changes
  // -------------------------------------------------------------------------

  onServerUp() {
    this.rebalance();
  }

  onServerDown(serverId: string) {
    for (const [opId, p] of this.pendingOps) {
      if (p.server === serverId) {
        clearTimeout(p.timer);
        this.pendingOps.delete(opId);
        p.reject(new OwnerSilent('session owner went away'));
      }
    }
    // Members of the lost server get a grace period to reconnect through
    // another server before we treat them as gone; this avoids needless host
    // failovers when only a coordinator (not the peer) went away.
    for (const s of [...this.owned.values()]) {
      for (const [peer, server] of [...s.memberServer]) {
        if (server !== serverId) continue;
        const key = `${s.state.id}|${peer}`;
        clearTimeout(this.orphanTimers.get(key));
        const timer = setTimeout(() => {
          this.orphanTimers.delete(key);
          const current = this.owned.get(s.state.id);
          if (current && current.memberServer.get(peer) === serverId)
            this.removeMember(current, peer);
        }, MEMBER_RECONNECT_GRACE_MS);
        timer.unref?.();
        this.orphanTimers.set(key, timer);
      }
    }
    for (const [sessionId, o] of [...this.occupancy]) {
      if (o.owner === serverId)
        this.setOccupancy(sessionId, { ...o.occ, members: [], host: null }, serverId);
    }
    this.rebalance();
  }

  private rebalance() {
    for (const sessionId of [...this.owned.keys()]) {
      if (this.ownerOf(sessionId) !== this.selfId) this.dropOwned(sessionId, false);
    }
    for (const [sessionId, members] of this.local) {
      const owner = this.ownerOf(sessionId);
      if (this.lastOwner.get(sessionId) === owner) continue;
      this.lastOwner.set(sessionId, owner);
      // The device signed for the server it joined from, and its join is too old to give to
      // the new one: it is asked to sign a new one, and leaves the room if it does not.
      for (const peer of [...members.keys()]) this.askToRenew(sessionId, peer);
    }
  }

  private endRenewal(key: string) {
    clearTimeout(this.renewing.get(key)?.timer);
    this.renewing.delete(key);
  }

  private askToRenew(sessionId: string, peer: string, deadline?: number) {
    const key = `${sessionId}|${peer}`;
    const running = this.renewing.get(key);
    clearTimeout(running?.timer);
    // Asked again (the owner changed again): the time it has is not made longer by that.
    deadline ??=
      running && running.deadline > Date.now()
        ? running.deadline
        : Date.now() + this.renewTimeoutMs;
    const client = this.hub.presence.localOf(peerIds.user(peer)).find((c) => c.peer === peer);
    if (!client) {
      this.renewing.delete(key);
      void this.leave(peer, sessionId);
      return;
    }
    const timer = setTimeout(
      () => {
        this.renewing.delete(key);
        this.dropUnrenewed(sessionId, peer);
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref?.();
    this.renewing.set(key, { timer, deadline });
    client.send('session_renew', { sessionId });
  }

  /**
   * Takes a device out of the room and tells whichever connection it now has (the one it was
   * asked on may have closed). `again`: it may join the room again (it did not sign in time),
   * as opposed to having lost the right to be in it.
   */
  private dropUnrenewed(sessionId: string, peer: string, again = true) {
    const what = { sessionId, peer };
    if (again)
      this.hub.log.warn('device did not give a new join that was taken; taking it out', what);
    else this.hub.log.info('device is no longer allowed in the room; taking it out', what);
    this.endRenewal(`${sessionId}|${peer}`);
    void this.leave(peer, sessionId);
    const client = this.hub.presence.localOf(peerIds.user(peer)).find((c) => c.peer === peer);
    client?.send('session_closed', {
      sessionId,
      reason: again ? 'did not sign a new join' : 'no longer allowed in',
      again,
    });
  }

  /**
   * A new join that was not taken (the new owner may not be reachable yet, or may be behind on
   * the records) is asked for again soon, until the time given for it has gone.
   */
  private askAgain(
    renewal: { deadline: number } | undefined,
    sessionId: string,
    client: Pick<ClientHandle, 'peer'>,
    err: unknown,
  ) {
    const peer = client.peer;
    if (!renewal) return;
    if (err instanceof RpcFailure && err.message === DEVICE_REMOVED) return;
    // What stands now, not what was when this join began: it may have been taken meanwhile by
    // another join (nothing to ask), or asked for again by an owner change (with a time of its own).
    const key = `${sessionId}|${peer}`;
    const live = this.renewing.get(key);
    if (!live) return;
    // Gone meanwhile: nobody to ask.
    if (!this.local.get(sessionId)?.has(peer)) {
      this.endRenewal(key);
      return;
    }
    const { deadline } = live;
    // The time it had has gone: whatever the new owner said, it is not in the room there.
    if (Date.now() >= deadline) {
      this.dropUnrenewed(sessionId, peer);
      return;
    }
    clearTimeout(live.timer);
    const timer = setTimeout(() => {
      if (this.renewing.get(key)?.timer !== timer) return;
      if (!this.local.get(sessionId)?.has(peer)) {
        this.renewing.delete(key);
        return;
      }
      if (Date.now() >= deadline) {
        this.renewing.delete(key);
        this.dropUnrenewed(sessionId, peer);
      } else this.askToRenew(sessionId, peer, deadline);
    }, this.renewRetryMs);
    timer.unref?.();
    this.renewing.set(key, { timer, deadline });
  }

  close() {
    clearInterval(this.voiceRefresh);
    clearInterval(this.deviceRecheck);
    clearInterval(this.joinSweep);
    for (const r of this.renewing.values()) clearTimeout(r.timer);
    for (const t of this.pendingLeaves.values()) clearTimeout(t);
    for (const t of this.orphanTimers.values()) clearTimeout(t);
    for (const s of this.owned.values()) if (s.timer) clearTimeout(s.timer);
    for (const p of this.pendingOps.values()) clearTimeout(p.timer);
  }
}
