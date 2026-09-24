import { z } from 'zod';

/**
 * Messages on the reliable data channel between a member and the host relay.
 * The relay only routes: payloads (`d`) are end-to-end encrypted envelopes it
 * cannot read. The relay stamps `from` with the identity proven during the
 * signed offer/answer exchange.
 */
export const RELAY_CHANNEL_LABEL = 'croc';
export const RELAY_CHANNEL_ID = 0;

const userId = z.string().regex(/^[a-z2-7]{8,64}$/);

export const ClientToRelay = z.discriminatedUnion('t', [
  z.object({ t: z.literal('bcast'), d: z.unknown() }),
  z.object({ t: z.literal('direct'), to: userId, d: z.unknown() }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  /** Client-side mute state so the relay can skip forwarding and show icons. */
  z.object({ t: z.literal('state'), muted: z.boolean(), deafened: z.boolean() }),
]);
export type ClientToRelay = z.infer<typeof ClientToRelay>;

export interface PeerState {
  userId: string;
  muted: boolean;
  deafened: boolean;
}

export type RelayToClient =
  | { t: 'hello'; you: string; host: string; peers: PeerState[]; slots: number }
  | { t: 'peer_join'; peer: PeerState }
  | { t: 'peer_leave'; userId: string }
  | { t: 'peer_state'; peer: PeerState }
  | { t: 'msg'; from: string; direct: boolean; d: unknown }
  /** Which speaker currently occupies each of this listener's audio slots. */
  | { t: 'slots'; map: (string | null)[] }
  | { t: 'speaking'; users: string[] }
  | { t: 'pong'; ts: number };

// ---------------------------------------------------------------------------
// End-to-end envelopes carried inside relay messages (`d`).
// ---------------------------------------------------------------------------

export const SealedBox = z.object({
  /** Ephemeral X25519 public key. */
  epk: z.string(),
  /** AES-256-GCM ciphertext (nonce is derived, see crypto/seal). */
  ct: z.string(),
  /** Sender's Ed25519 public key. */
  from: z.string(),
  /** Signature over (domain, epk, ct, recipient). */
  sig: z.string(),
});
export type SealedBox = z.infer<typeof SealedBox>;

export const E2EEnvelope = z.discriminatedUnion('k', [
  /** Pairwise-sealed payload: sender keys, history sync, receipts. */
  z.object({ k: z.literal('sealed'), box: SealedBox }),
  /** Group message encrypted with the sender's current sender key. */
  z.object({
    k: z.literal('group'),
    kid: z.number().int().min(0).max(0xffffffff),
    n: z.number().int().min(0),
    ct: z.string(),
  }),
]);
export type E2EEnvelope = z.infer<typeof E2EEnvelope>;

/** A chat message. Signed by its author so history can be re-shared verifiably. */
export const ChatMessage = z.object({
  id: z.string().min(10).max(40),
  /** Channel id, or the DM session id for direct messages. */
  ch: z.string().max(200),
  author: userId,
  /** Author's Ed25519 key; userId must equal hash(key). */
  key: z.string(),
  ts: z.number().int(),
  body: z.string().max(4000),
  replyTo: z.string().max(40).optional(),
  /** Set on edits: id of the message being replaced. */
  edits: z.string().max(40).optional(),
  deleted: z.boolean().optional(),
  sig: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Plaintext of a sealed envelope. */
export const SealedPayload = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sender_key'),
    /** Session the key belongs to; guards against cross-session replay. */
    sessionId: z.string(),
    kid: z.number().int().min(0).max(0xffffffff),
    key: z.string(),
  }),
  z.object({
    type: z.literal('history_req'),
    /** channelId -> newest timestamp the requester already has. */
    since: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('history'),
    messages: z.array(ChatMessage).max(500),
    done: z.boolean(),
  }),
  z.object({ type: z.literal('message'), message: ChatMessage }),
]);
export type SealedPayload = z.infer<typeof SealedPayload>;

/** Plaintext of a group envelope. */
export const GroupPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: ChatMessage }),
  z.object({ type: z.literal('typing'), ch: z.string().max(200) }),
  /** Direct-call signalling inside a DM session. */
  z.object({ type: z.literal('call'), action: z.enum(['ring', 'accept', 'decline', 'end']) }),
]);
export type GroupPayload = z.infer<typeof GroupPayload>;
