import { isSpaceMember, randomId } from '@crocodile/crypto';
import {
  DEFAULT_RELAY_SLOTS,
  LIMITS,
  parseSessionId,
  peerIds,
  type FedSessionOp,
  type FedVoice,
  type HostCaps,
  type SessionOp,
  type SessionState,
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
  reports: Set<string>;
  /** Host adopted from a hint whose member has not re-joined yet. */
  pendingHostUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

type Hint = { epoch: number; host: string | null; backup: string | null };

const PENDING_HOST_GRACE_MS = 4000;
const HOST_PENALTY_MS = 60_000;
const OP_TIMEOUT_MS = 8000;
const MEMBER_RECONNECT_GRACE_MS = 10_000;

/**
 * Sessions and host election.
 *
 * Each session is owned by exactly one coordination server, chosen by
 * rendezvous hashing over the live mesh. Members' own servers keep a registry
 * of which local clients are in which session and forward operations to the
 * owner; when the mesh changes and a session gets a new owner, the member
 * servers simply re-submit their joins (with a hint of the last known host)
 * so the new owner rebuilds identical state without disturbing the call.
 */
export class SessionService {
  /** sessionId -> local peer id -> caps */
  private local = new Map<string, Map<string, HostCaps>>();
  private lastOwner = new Map<string, string>();
  private lastKnown = new Map<string, Hint>();
  private owned = new Map<string, OwnedSession>();
  private occupancy = new Map<string, { occ: VoiceOccupancy; owner: string }>();
  private pendingOps = new Map<
    string,
    {
      server: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly hub: Coordinator) {}

  get selfId() {
    return this.hub.info.id;
  }

  liveServers(): string[] {
    return [this.selfId, ...this.hub.mesh.peerIds()].sort();
  }

  ownerOf(sessionId: string): string {
    return rendezvousOwner(sessionId, this.liveServers());
  }

  // -------------------------------------------------------------------------
  // Client-facing operations (called on the member's own server)
  // -------------------------------------------------------------------------

  checkAccess(userId: string, sessionId: string) {
    const scope = parseSessionId(sessionId);
    if (!scope) throw new RpcFailure('bad_request', 'invalid session id');
    const records = this.hub.records;
    if (scope.kind === 'space' || scope.kind === 'voice') {
      if (!isSpaceMember(records, scope.spaceId, userId))
        throw new RpcFailure('forbidden', 'not a member of this space');
      if (scope.kind === 'voice') {
        const space = records.get(`space:${scope.spaceId}`) as SignedRecord<'space'>;
        const channel = space.body.channels.find((c) => c.id === scope.channelId);
        if (!channel || channel.kind !== 'voice')
          throw new RpcFailure('not_found', 'no such voice channel');
      }
      return;
    }
    const [a, b] = scope.users;
    if (userId !== a && userId !== b)
      throw new RpcFailure('forbidden', 'not part of this conversation');
    const other = userId === a ? b : a;
    const theirs = records.get(`friends:${other}`) as SignedRecord<'friends'> | undefined;
    if (theirs?.body.blocked.includes(userId))
      throw new RpcFailure('forbidden', 'this user is not accepting messages from you');
  }

  inSession(peer: string, sessionId: string) {
    return this.local.get(sessionId)?.has(peer) ?? false;
  }

  async join(client: ClientHandle, sessionId: string, caps: HostCaps): Promise<SessionState> {
    this.checkAccess(client.userId, sessionId);
    const leaveKey = `${sessionId}|${client.peer}`;
    clearTimeout(this.pendingLeaves.get(leaveKey));
    this.pendingLeaves.delete(leaveKey);
    let members = this.local.get(sessionId);
    if (!members) this.local.set(sessionId, (members = new Map()));
    members.set(client.peer, caps);
    this.lastOwner.set(sessionId, this.ownerOf(sessionId));
    const hint = this.lastKnown.get(sessionId);
    const state = (await this.submit(sessionId, client.peer, {
      op: 'join',
      caps,
      ...(hint ? { hint } : {}),
    })) as SessionState;
    return state;
  }

  async update(client: ClientHandle, sessionId: string, caps: HostCaps) {
    const members = this.local.get(sessionId);
    if (!members?.has(client.peer)) throw new RpcFailure('not_found', 'not in session');
    members.set(client.peer, caps);
    await this.submit(sessionId, client.peer, { op: 'update', caps });
  }

  async leave(peer: string, sessionId: string) {
    const members = this.local.get(sessionId);
    if (!members?.delete(peer)) return;
    if (members.size === 0) {
      this.local.delete(sessionId);
      this.lastOwner.delete(sessionId);
      this.lastKnown.delete(sessionId);
    }
    await this.submit(sessionId, peer, { op: 'leave' }).catch(() => {});
  }

  async report(client: ClientHandle, sessionId: string, epoch: number) {
    if (!this.inSession(client.peer, sessionId))
      throw new RpcFailure('not_found', 'not in session');
    await this.submit(sessionId, client.peer, { op: 'report', epoch, issue: 'host_unreachable' });
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

  /** Called when a 'session' event reaches a local member: remember the host. */
  noteState(state: SessionState) {
    if (this.local.has(state.id))
      this.lastKnown.set(state.id, { epoch: state.epoch, host: state.host, backup: state.backup });
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

  private submit(sessionId: string, peer: string, op: SessionOp): Promise<unknown> {
    const owner = this.ownerOf(sessionId);
    if (owner === this.selfId) {
      try {
        return Promise.resolve(this.apply(sessionId, peer, this.selfId, op));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const opId = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOps.delete(opId);
        reject(new RpcFailure('unavailable', 'session owner did not respond'));
      }, OP_TIMEOUT_MS);
      this.pendingOps.set(opId, { server: owner, resolve, reject, timer });
      const sent = this.hub.mesh.sendTo(owner, { t: 'session_op', opId, sessionId, peer, op });
      if (!sent) {
        clearTimeout(timer);
        this.pendingOps.delete(opId);
        reject(new RpcFailure('unavailable', 'session owner unreachable'));
      }
    });
  }

  handleRemoteOp(fromServer: string, frame: FedSessionOp) {
    try {
      const ok = this.apply(frame.sessionId, frame.peer, fromServer, frame.op);
      this.hub.mesh.sendTo(fromServer, { t: 'session_op_res', opId: frame.opId, ok });
    } catch (err) {
      const code = err instanceof RpcFailure ? err.code : 'internal';
      this.hub.mesh.sendTo(fromServer, {
        t: 'session_op_res',
        opId: frame.opId,
        err: { code, message: err instanceof Error ? err.message : String(err) },
      });
    }
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
          penalties: new Map(),
          reports: new Set(),
          pendingHostUntil: 0,
        };
        this.owned.set(sessionId, s);
      }
      if (op.hint && op.hint.epoch > s.state.epoch) {
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
        if (!member || op.epoch !== s.state.epoch || !s.state.host || peer === s.state.host)
          return {};
        s.reports.add(peer);
        const others = s.state.members.length - 1;
        if (s.reports.size >= Math.max(1, Math.ceil(others / 2))) {
          s.penalties.set(s.state.host, now + HOST_PENALTY_MS);
          this.hub.log.info('host reported unreachable; failing over', {
            sessionId,
            host: s.state.host,
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
        members: st.members,
        host: null,
        backup: st.backup,
        penalties: s.penalties,
        now,
      });
      result = { host: st.host, backup: others.host === st.host ? others.backup : others.host };
    } else {
      result = elect({
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
    for (const m of s.state.members) this.hub.deliverToPeer(m.peer, 'session', { state: s.state });
    this.announceVoice(s.state);
  }

  // -------------------------------------------------------------------------
  // Voice channel occupancy (mesh-wide, so any server can answer voice.watch)
  // -------------------------------------------------------------------------

  private announceVoice(state: SessionState) {
    const scope = parseSessionId(state.id);
    if (!scope || scope.kind !== 'voice') return;
    const occ: VoiceOccupancy = {
      spaceId: scope.spaceId,
      channelId: scope.channelId,
      members: [...new Set(state.members.map((m) => m.userId))],
      host: state.host ? peerIds.user(state.host) : null,
    };
    this.setOccupancy(state.id, occ, this.selfId);
    this.hub.mesh.broadcast({ t: 'voice', sessionId: state.id, occ });
  }

  applyRemoteVoice(serverId: string, frame: FedVoice) {
    this.setOccupancy(frame.sessionId, frame.occ, serverId);
  }

  private setOccupancy(sessionId: string, occ: VoiceOccupancy, owner: string) {
    if (occ.members.length === 0) this.occupancy.delete(sessionId);
    else this.occupancy.set(sessionId, { occ, owner });
    for (const client of this.hub.presence.localClients()) {
      if (client.voiceWatch.has(occ.spaceId)) client.send('voice', occ);
    }
  }

  voiceSnapshot(spaceIds: string[]): VoiceOccupancy[] {
    const wanted = new Set(spaceIds);
    return [...this.occupancy.values()].map((o) => o.occ).filter((o) => wanted.has(o.spaceId));
  }

  ownedVoiceFrames(): FedVoice[] {
    return [...this.occupancy]
      .filter(([, o]) => o.owner === this.selfId)
      .map(([sessionId, o]) => ({ t: 'voice', sessionId, occ: o.occ }));
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
        p.reject(new RpcFailure('unavailable', 'session owner went away'));
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
      const hint = this.lastKnown.get(sessionId);
      for (const [peer, caps] of members) {
        this.submit(sessionId, peer, { op: 'join', caps, ...(hint ? { hint } : {}) }).catch((err) =>
          this.hub.log.warn('re-join after owner change failed', { sessionId, err: String(err) }),
        );
      }
    }
  }

  close() {
    for (const t of this.pendingLeaves.values()) clearTimeout(t);
    for (const t of this.orphanTimers.values()) clearTimeout(t);
    for (const s of this.owned.values()) if (s.timer) clearTimeout(s.timer);
    for (const p of this.pendingOps.values()) clearTimeout(p.timer);
  }
}
