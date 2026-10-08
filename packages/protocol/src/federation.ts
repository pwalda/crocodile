import { z } from 'zod';
import type { SignedRecord } from './records';
import type { ServerInfo } from './rpc';
import type { HostCaps, VoiceOccupancy } from './session';

/**
 * Server-to-server protocol (WebSocket /v1/federation). Servers keep a few
 * overlay links and open direct ones as needed; records live on a few owner
 * servers each (docs/MESH.md). Owners copy records to each other, with
 * per-server sequence cursors to catch up; what every server needs to hear is
 * flooded through the overlay.
 */
export interface FedHello {
  t: 'fed_hello';
  server: ServerInfo;
  challenge: string;
  /** Fresh hybrid key-exchange offer for the encrypted link. */
  channel: { x25519: string; mlkem: string };
  /** PROTOCOL_VERSION of the sender; absent before 2. */
  protocol?: number;
}

/** "I'm alive", flooded every few seconds. Signed, so it can travel through others. */
export interface FedBeacon {
  t: 'beacon';
  server: ServerInfo;
  /** Increases with every beacon (a timestamp). */
  seq: number;
  /** The sender keeps a copy of every record. */
  full: boolean;
  /** Ed25519 by the server key over { server, seq, full }. */
  sig: string;
}

/** A frame for every server, passed on by each to its other links. */
export interface FedFlood {
  t: 'flood';
  /** Unique; a server passes each id on once. */
  id: string;
  /** The server it came from. */
  origin: string;
  hops: number;
  f: FedLinkQuery | FedLinkAnswer | FedMailQuery | FedMailAck;
}

/** A request to one server; answered with FedResponse. */
export interface FedRequest {
  t: 'req';
  rid: string;
  m: 'rec_put' | 'rec_get' | 'rec_list' | 'rec_term' | 'watch' | 'digest' | 'digest_keys';
  p: unknown;
}

/** Parameters of each FedRequest method; servers check them like client input. */
export const FedRequestParams = {
  /** A client's new record, for an owner of its home shard to check (fresh) and store. */
  rec_put: z.object({ record: z.unknown() }),
  rec_get: z.object({ keys: z.array(z.string().max(200)).max(1000) }),
  rec_list: z.object({
    prefix: z.string().min(3).max(200),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  rec_term: z.object({
    term: z.string().min(3).max(300),
    limit: z.number().int().min(1).max(5000).optional(),
  }),
  /** Push changes to these shards (records whose key starts with prefix) for ttlMs. */
  watch: z.object({
    items: z
      .array(z.object({ shard: z.string().min(3).max(300), prefix: z.string().max(200) }))
      .max(5000),
    ttlMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60_000),
  }),
  /**
   * Repair: 256 bucket sums over the records both servers own; the answer
   * lists the buckets that differ.
   */
  digest: z.object({ buckets: z.array(z.number().int().min(0)).length(256) }),
  /** Repair: (key, version) of the records both own, in these buckets. */
  digest_keys: z.object({ buckets: z.array(z.number().int().min(0).max(255)).max(256) }),
} as const;

export interface FedResponse {
  t: 'res';
  rid: string;
  ok?: unknown;
  err?: { code: string; message: string };
}

/** A record a watching server asked to hear about; not for storing. */
export interface FedRecordPush {
  t: 'rec_push';
  record: SignedRecord;
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
  /** The server these users are connected to. */
  origin: string;
  /** Increases with every update from the origin; older ones are ignored. */
  seq: number;
  /** true: replace everything known about the origin's users. */
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

/** Voice channel occupancy announced by the session owner to every server. */
export interface FedVoice {
  t: 'voice';
  sessionId: string;
  occ: VoiceOccupancy;
  /** The session's owner. */
  owner: string;
  /** When the owner announced it; the latest per session wins. */
  at: number;
}

export type FedFrame =
  | FedHello
  | FedAuth
  | FedBeacon
  | FedFlood
  | FedRequest
  | FedResponse
  | FedRecordPush
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
