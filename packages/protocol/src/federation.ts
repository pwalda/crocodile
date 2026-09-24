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
  /** Fresh hybrid key-exchange offer for the encrypted link. */
  channel: { x25519: string; mlkem: string };
}

export interface FedAuth {
  t: 'fed_auth';
  /** Our answer to the peer's channel offer. */
  answer: { epk: string; kem: string };
  /** Signature over (peer challenge, own id, peer id, own offer, answer). */
  sig: string;
  /** Highest seq of the peer's log that we have already applied. */
  cursor: number;
}

/** Device linking: find which server holds a link code. */
export interface FedLinkQuery {
  t: 'link_query';
  qid: string;
  code: string;
}

export interface FedLinkAnswer {
  t: 'link_answer';
  qid: string;
  found?: { peer: string; key: string; encKey: string };
}

/** Mailbox: a device connected here; servers holding mail for it send it over. */
export interface FedMailQuery {
  t: 'mail_query';
  peer: string;
}

/** Mailbox: the device received these items; everyone may delete them. */
export interface FedMailAck {
  t: 'mail_ack';
  peer: string;
  ids: string[];
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
    /** Device ids of the user connected to the sender. */
    devices: string[];
  }[];
}

/** Deliver a client event to a user connected to the receiving server. */
export interface FedRoute {
  t: 'route';
  /** A user id (all their devices on the receiver) or a peer id (one device). */
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
  /** Peer id of the member. */
  peer: string;
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
  | FedLinkQuery
  | FedLinkAnswer
  | FedMailQuery
  | FedMailAck
  | { t: 'x'; n: number; c: string }
  | { t: 'ping' }
  | { t: 'pong' };
