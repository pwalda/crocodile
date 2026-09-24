import {
  RECORD_BODY_SCHEMAS,
  SIG_DOMAIN,
  SignedRecordEnvelope,
  toB32,
  utf8,
  type RecordBodies,
  type RecordKind,
  type SignedRecord,
  type SpaceBody,
  LIMITS,
  canonicalJson,
} from '@crocodile/protocol';
import { sha256, verifyPayload } from './primitives';
import { sign, userIdFromKey, USER_ID_LENGTH, type Identity } from './identity';

export interface RecordLookup {
  get(key: string): SignedRecord | undefined;
}

export interface ValidationContext extends RecordLookup {
  now: number;
  /**
   * True when the record comes straight from its author (a client put) rather
   * than from mesh replication. Fresh records get time-sensitive checks
   * (version close to now, invite not expired or revoked, not banned).
   */
  fresh: boolean;
}

export type ValidationResult =
  | { ok: true; authorId: string }
  | { ok: false; reason: string; retryable?: boolean };

/** Max clock skew tolerated for a record version in the future. */
const MAX_FUTURE_MS = 5 * 60_000;
/** Fresh client writes must carry a version at most this far in the past. */
const MAX_FRESH_AGE_MS = 10 * 60_000;

function signedPart(r: Omit<SignedRecord, 'sig'>) {
  return { v: r.v, kind: r.kind, key: r.key, author: r.author, version: r.version, body: r.body };
}

export function signRecord<K extends RecordKind>(
  identity: Identity,
  kind: K,
  key: string,
  body: RecordBodies[K],
  version = Date.now(),
): SignedRecord<K> {
  const unsigned = { v: 1 as const, kind, key, author: identity.publicKey, version, body };
  return { ...unsigned, sig: sign(identity, SIG_DOMAIN.record, signedPart(unsigned)) };
}

/** Space ids bind the owner key, so any server can check ownership without history. */
export function spaceIdFor(ownerPublicKey: string, nonce: string): string {
  return toB32(sha256(utf8.encode(`croc/v1/space\n${ownerPublicKey}\n${nonce}`))).slice(0, USER_ID_LENGTH);
}

export function validateRecord(input: unknown, ctx: ValidationContext): ValidationResult {
  const env = SignedRecordEnvelope.safeParse(input);
  if (!env.success) return { ok: false, reason: 'malformed record envelope' };
  const record = env.data as SignedRecord;

  if (canonicalJson(record).length > LIMITS.recordMaxBytes) return { ok: false, reason: 'record too large' };

  const bodyResult = RECORD_BODY_SCHEMAS[record.kind].safeParse(record.body);
  if (!bodyResult.success) {
    return { ok: false, reason: `invalid ${record.kind} body: ${bodyResult.error.issues[0]?.message ?? ''}` };
  }
  if (!record.key.startsWith(`${record.kind}:`)) return { ok: false, reason: 'key does not match kind' };
  if (record.version > ctx.now + MAX_FUTURE_MS) return { ok: false, reason: 'version is in the future' };
  if (ctx.fresh && record.version < ctx.now - MAX_FRESH_AGE_MS) {
    return { ok: false, reason: 'version too old; check your clock' };
  }
  if (!verifyPayload(record.author, SIG_DOMAIN.record, signedPart(record), record.sig)) {
    return { ok: false, reason: 'bad signature' };
  }

  const authorId = userIdFromKey(record.author);
  const parts = record.key.split(':');
  const existing = ctx.get(record.key);
  if (existing && existing.version >= record.version) {
    return { ok: false, reason: 'stale version' };
  }

  const reject = (reason: string, retryable = false): ValidationResult => ({ ok: false, reason, retryable });

  switch (record.kind) {
    case 'profile':
    case 'friends': {
      if (parts.length !== 2 || parts[1] !== authorId) return reject('only the user may write this record');
      return { ok: true, authorId };
    }
    case 'space': {
      const body = record.body as SpaceBody;
      if (parts.length !== 2) return reject('bad space key');
      if (body.owner !== authorId) return reject('only the owner may write a space');
      if (spaceIdFor(record.author, body.nonce) !== parts[1]) return reject('space id does not match owner');
      return { ok: true, authorId };
    }
    case 'invite': {
      const body = record.body as RecordBodies['invite'];
      if (parts.length !== 2 || body.code !== parts[1]) return reject('invite key mismatch');
      const space = ctx.get(`space:${body.spaceId}`) as SignedRecord<'space'> | undefined;
      if (!space) return reject('unknown space', true);
      if (space.body.owner !== authorId) return reject('only the space owner may create invites');
      if (existing && (existing.body as RecordBodies['invite']).spaceId !== body.spaceId) {
        return reject('invite code already used');
      }
      return { ok: true, authorId };
    }
    case 'member': {
      const body = record.body as RecordBodies['member'];
      if (parts.length !== 3 || parts[1] !== body.spaceId || parts[2] !== body.userId) {
        return reject('member key mismatch');
      }
      if (body.userId !== authorId) return reject('only the user may write their membership');
      if (body.left) return { ok: true, authorId };
      const space = ctx.get(`space:${body.spaceId}`) as SignedRecord<'space'> | undefined;
      if (!space) return reject('unknown space', true);
      if (space.body.deleted) return reject('space was deleted');
      if (space.body.owner === authorId) return { ok: true, authorId };
      if (ctx.fresh && space.body.bans.includes(authorId)) return reject('you are banned from this space');
      // Re-signing an existing active membership (e.g. rejoin after leave) needs a valid invite too.
      if (!body.inviteCode) return reject('an invite is required');
      const invite = ctx.get(`invite:${body.inviteCode}`) as SignedRecord<'invite'> | undefined;
      if (!invite) return reject('unknown invite', true);
      if (invite.body.spaceId !== body.spaceId) return reject('invite is for another space');
      if (ctx.fresh) {
        if (invite.body.revoked) return reject('invite was revoked');
        if (invite.body.expiresAt !== null && invite.body.expiresAt < ctx.now) return reject('invite expired');
      }
      return { ok: true, authorId };
    }
  }
}

/** True if the user currently belongs to the space (owner or active, non-banned member). */
export function isSpaceMember(lookup: RecordLookup, spaceId: string, userId: string): boolean {
  const space = lookup.get(`space:${spaceId}`) as SignedRecord<'space'> | undefined;
  if (!space || space.body.deleted) return false;
  if (space.body.owner === userId) return true;
  if (space.body.bans.includes(userId)) return false;
  const member = lookup.get(`member:${spaceId}:${userId}`) as SignedRecord<'member'> | undefined;
  return !!member && !member.body.left;
}
