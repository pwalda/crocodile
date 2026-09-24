import type { SignedRecord } from './records';
import type { ServerInfo } from './rpc';
import type { HostCaps, VoiceOccupancy } from './session';

/**
 * Server-to-server mesh protocol (WebSocket /v1/federation). Every coordination
 * server keeps a link to every other server it learns about from the
 * directory (or from gossip). Records are replicated by anti-entropy using
 * per-server sequence cursors; presence and session operations are routed.
 */
export interface FedHello {
  t: 'fed_hello';
  server: ServerInfo;
  challenge: string;
}

export interface FedAuth {
  t: 'fed_auth';
  /** Signature over (peer challenge, own id, peer id). */
  sig: string;
  /** Highest seq of the peer's log that we have already applied. */
  cursor: number;
}

export interface FedRecords {
  t: 'records';
  items: { seq: number; record: SignedRecord }[];
  /** Sender's latest seq covered by this batch. */
  upTo: number;
}

export interface FedPresence {
  t: 'presence';
  /** true: replace everything known about the sender's users. */
  full: boolean;
  /**
   * Status of users connected to the sender. 'invisible' users still need to be
   * routable, so the mesh knows them, but clients are shown 'offline'.
   */
  entries: {
    userId: string;
    status: 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';
    text?: string;
    since: number;
  }[];
}

/** Deliver a client event to a user connected to the receiving server. */
export interface FedRoute {
  t: 'route';
  to: string;
  ev: string;
  d: unknown;
}

export type SessionOp =
  | {
      op: 'join';
      caps: HostCaps;
      /** Last state the member's server saw; lets a new owner keep the same host. */
      hint?: { epoch: number; host: string | null; backup: string | null };
    }
  | { op: 'update'; caps: HostCaps }
  | { op: 'leave' }
  | { op: 'report'; epoch: number; issue: 'host_unreachable' };

/** A session operation forwarded to the server that owns the session. */
export interface FedSessionOp {
  t: 'session_op';
  opId: string;
  sessionId: string;
  userId: string;
  op: SessionOp;
}

export interface FedSessionOpResult {
  t: 'session_op_res';
  opId: string;
  ok?: unknown;
  err?: { code: string; message: string };
}

/** Known-server gossip so meshes converge even if the directory is down. */
export interface FedServers {
  t: 'servers';
  servers: ServerInfo[];
}

/** Voice channel occupancy announced by the session owner to the whole mesh. */
export interface FedVoice {
  t: 'voice';
  sessionId: string;
  occ: VoiceOccupancy;
}

export type FedFrame =
  | FedHello
  | FedAuth
  | FedRecords
  | FedPresence
  | FedRoute
  | FedSessionOp
  | FedSessionOpResult
  | FedServers
  | FedVoice
  | { t: 'ping' }
  | { t: 'pong' };
