import { z } from 'zod';
import type { SignedRecord } from './records';
import { SignedRecordEnvelope } from './records';
import { HostCaps, SessionId, type SessionState, type VoiceOccupancy, Platform } from './session';

/** Public identity of a coordination server. */
export const ServerInfo = z.object({
  /** base32(sha256(key))[:26] */
  id: z.string(),
  /** Ed25519 public key, base64url. */
  key: z.string(),
  name: z.string().max(64),
  /** Public base URL, e.g. https://croc.example.org or http://203.0.113.4:7443 */
  url: z.string().url(),
  version: z.string().max(32),
  region: z.string().max(32).optional(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

export const PresenceStatus = z.enum(['online', 'idle', 'dnd', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

export interface PresenceEntry {
  userId: string;
  status: PresenceStatus;
  /** Custom status text. */
  text?: string;
}

// ---------------------------------------------------------------------------
// Handshake (WebSocket /v1/client)
// ---------------------------------------------------------------------------

export interface ServerHello {
  t: 'hello';
  server: ServerInfo;
  challenge: string;
  /** STUN URLs clients should use for ICE. */
  stun: string[];
  time: number;
  /** Server signature over (challenge, server.id, time). */
  sig: string;
}

export const ClientAuth = z.object({
  t: z.literal('auth'),
  key: z.string(),
  /** Signature over (challenge, server.id). */
  sig: z.string(),
  client: z.object({
    platform: Platform,
    version: z.string().max(32),
  }),
});
export type ClientAuth = z.infer<typeof ClientAuth>;

export interface AuthOk {
  t: 'auth_ok';
  userId: string;
}

export interface RpcRequest {
  t: 'req';
  id: number;
  m: string;
  p: unknown;
}

export interface RpcError {
  code:
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'unavailable'
    | 'internal';
  message: string;
}

export interface RpcResponse {
  t: 'res';
  id: number;
  ok?: unknown;
  err?: RpcError;
}

export interface RpcEvent {
  t: 'ev';
  ev: keyof ServerEvents;
  d: unknown;
}

export type ServerFrame = ServerHello | AuthOk | RpcResponse | RpcEvent | { t: 'error'; err: RpcError };
export type ClientFrame = ClientAuth | RpcRequest;

// ---------------------------------------------------------------------------
// Signalling between a member and the session host's relay. Opaque to the
// coordination server apart from routing; SDP is signed by the sender's
// identity key so a malicious server cannot splice in its own DTLS endpoint.
// ---------------------------------------------------------------------------

export const SignalData = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('offer'),
    epoch: z.number().int(),
    sdp: z.string().max(64_000),
    key: z.string(),
    sig: z.string(),
  }),
  z.object({
    type: z.literal('answer'),
    epoch: z.number().int(),
    sdp: z.string().max(64_000),
    key: z.string(),
    sig: z.string(),
  }),
  z.object({
    type: z.literal('candidate'),
    epoch: z.number().int(),
    dir: z.enum(['toRelay', 'toClient']),
    candidate: z.object({
      candidate: z.string().max(1024),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal('bye'),
    epoch: z.number().int(),
    dir: z.enum(['toRelay', 'toClient']),
  }),
]);
export type SignalData = z.infer<typeof SignalData>;

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

const userId = z.string().regex(/^[a-z2-7]{8,64}$/);

export const RpcParams = {
  'records.put': z.object({ record: SignedRecordEnvelope }),
  'records.get': z.object({ keys: z.array(z.string().max(200)).max(500) }),
  'records.list': z.object({ prefix: z.string().min(3).max(200), limit: z.number().int().max(5000).optional() }),
  'records.subscribe': z.object({ prefixes: z.array(z.string().min(3).max(200)).max(2000) }),
  'users.search': z.object({ query: z.string().min(1).max(64) }),
  'friends.incoming': z.object({}),
  'spaces.mine': z.object({}),
  'presence.subscribe': z.object({ userIds: z.array(userId).max(5000) }),
  'presence.set': z.object({
    status: z.enum(['online', 'idle', 'dnd', 'invisible']),
    text: z.string().max(128).optional(),
  }),
  'session.join': z.object({ sessionId: SessionId, caps: HostCaps }),
  'session.leave': z.object({ sessionId: SessionId }),
  'session.update': z.object({ sessionId: SessionId, caps: HostCaps }),
  'session.report': z.object({
    sessionId: SessionId,
    epoch: z.number().int(),
    issue: z.enum(['host_unreachable']),
  }),
  'voice.watch': z.object({ spaceIds: z.array(userId).max(200) }),
  'signal.send': z.object({ to: userId, sessionId: SessionId, data: SignalData }),
  'servers.list': z.object({}),
} as const;

export interface RpcMethods {
  'records.put': { accepted: boolean; current: SignedRecord | null; reason?: string };
  'records.get': { records: SignedRecord[] };
  'records.list': { records: SignedRecord[] };
  'records.subscribe': Record<string, never>;
  'users.search': { profiles: SignedRecord<'profile'>[] };
  'friends.incoming': { records: SignedRecord<'friends'>[] };
  'spaces.mine': { spaces: SignedRecord<'space'>[]; members: SignedRecord<'member'>[] };
  'presence.subscribe': { presence: PresenceEntry[] };
  'presence.set': Record<string, never>;
  'session.join': { state: SessionState };
  'session.leave': Record<string, never>;
  'session.update': Record<string, never>;
  'session.report': Record<string, never>;
  'voice.watch': { voice: VoiceOccupancy[] };
  'signal.send': { delivered: boolean };
  'servers.list': { servers: ServerInfo[] };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParamsOf<M extends RpcMethod> = z.input<(typeof RpcParams)[M]>;

export interface ServerEvents {
  record: { record: SignedRecord };
  presence: PresenceEntry;
  session: { state: SessionState };
  /** The session no longer includes you (kicked, space left, or server moved it). */
  session_closed: { sessionId: string; reason: string };
  signal: { from: string; sessionId: string; data: SignalData };
  voice: VoiceOccupancy;
  /** Another connection authenticated with the same identity. */
  replaced: { reason: string };
}
