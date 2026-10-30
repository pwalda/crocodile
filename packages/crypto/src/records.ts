import {
  RECORD_BODY_SCHEMAS,
  SIG_DOMAIN,
  SignedRecordEnvelope,
  fromB32,
  fromB64u,
  toB32,
  toB64u,
  utf8,
  type RecordBodies,
  type RecordKind,
  type SignedRecord,
  type SpaceBody,
  LIMITS,
  NOTE_TTL_MS,
  canonicalJson,
  peerIds,
  recordKey,
  DELETED_PROFILE_NAME,
} from '@crocodile/protocol';
import { ed25519, randomBytes, sha256, signPayload, verifyPayload } from './primitives';
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
  { ok: true; authorId: string } | { ok: false; reason: string; retryable?: boolean };

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

/**
 * What a space names its open invite by: not the code itself, which only those given it hold.
 * Tied to the space, so one hash does not serve for every space.
 */
export function inviteCommitment(spaceId: string, code: string): string {
  return toB32(sha256(utf8.encode(`croc/v1/open-invite\n${spaceId}\n${code}`))).slice(0, 26);
}

/** Characters in the code of an open link (128 bits): too many to guess from the hash. */
export const OPEN_CODE_LENGTH = 26;

/**
 * An open link as a ticket. `secret` is what the link carries (32 bytes, base32); it is never
 * put in a record. `tpub` is its public key and `tid` (what the invite is called) is a hash of
 * that, so the name of the invite does not give the secret away.
 */
export interface Ticket {
  secret: string;
  tpub: string;
  tid: string;
}

/** Characters in the secret of a ticket link. */
export const TICKET_SECRET_LENGTH = 52;

export function ticketIdOf(tpub: string): string {
  return toB32(sha256(fromB64u(tpub))).slice(0, USER_ID_LENGTH);
}

/** The ticket a link's secret stands for, or null if it is not one. */
export function ticketFromSecret(secret: string): Ticket | null {
  const clean = secret.trim().toLowerCase();
  if (!/^[a-z2-7]+$/.test(clean) || clean.length !== TICKET_SECRET_LENGTH) return null;
  const seed = fromB32(clean);
  if (seed.length !== 32) return null;
  const tpub = toB64u(ed25519.getPublicKey(seed));
  return { secret: clean, tpub, tid: ticketIdOf(tpub) };
}

export function newTicket(): Ticket {
  return ticketFromSecret(toB32(randomBytes(32)).slice(0, TICKET_SECRET_LENGTH))!;
}

/** The part of a ticket's use that is signed: this user, in this space, with this invite. */
function ticketUsePayload(spaceId: string, tid: string, userId: string) {
  return { spaceId, tid, userId };
}

/** What a member record carries to show it holds the link: a signature by the link's secret. */
export function signTicketUse(
  ticket: Pick<Ticket, 'secret' | 'tid'>,
  spaceId: string,
  userId: string,
): string {
  return signPayload(
    fromB32(ticket.secret),
    SIG_DOMAIN.ticketUse,
    ticketUsePayload(spaceId, ticket.tid, userId),
  );
}

/** Space ids bind the owner key, so any server can check ownership without history. */
export function spaceIdFor(ownerPublicKey: string, nonce: string): string {
  return toB32(sha256(utf8.encode(`croc/v1/space\n${ownerPublicKey}\n${nonce}`))).slice(
    0,
    USER_ID_LENGTH,
  );
}

export function validateRecord(input: unknown, ctx: ValidationContext): ValidationResult {
  const env = SignedRecordEnvelope.safeParse(input);
  if (!env.success) return { ok: false, reason: 'malformed record envelope' };
  const record = env.data as SignedRecord;

  if (canonicalJson(record).length > LIMITS.recordMaxBytes)
    return { ok: false, reason: 'record too large' };

  const bodyResult = RECORD_BODY_SCHEMAS[record.kind].safeParse(record.body);
  if (!bodyResult.success) {
    return {
      ok: false,
      reason: `invalid ${record.kind} body: ${bodyResult.error.issues[0]?.message ?? ''}`,
    };
  }
  if (!record.key.startsWith(`${record.kind}:`))
    return { ok: false, reason: 'key does not match kind' };
  if (record.version > ctx.now + MAX_FUTURE_MS)
    return { ok: false, reason: 'version is in the future' };
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

  const reject = (reason: string, retryable = false): ValidationResult => ({
    ok: false,
    reason,
    retryable,
  });

  // A deleted account signs nothing more, its own profile included.
  const authorProfile = ctx.get(`profile:${authorId}`) as SignedRecord<'profile'> | undefined;
  if (authorProfile?.body.deleted) return reject('account was deleted');

  switch (record.kind) {
    case 'profile':
    case 'friends': {
      if (parts.length !== 2 || parts[1] !== authorId)
        return reject('only the user may write this record');
      const body = record.body as RecordBodies['profile'];
      if (
        record.kind === 'profile' &&
        body.deleted &&
        (body.username !== DELETED_PROFILE_NAME || body.avatar || body.bio || body.accent)
      ) {
        return reject('a deleted profile carries no details');
      }
      return { ok: true, authorId };
    }
    case 'device': {
      const body = record.body as RecordBodies['device'];
      if (
        parts.length !== 3 ||
        parts[1] !== authorId ||
        body.userId !== authorId ||
        body.deviceId !== parts[2]
      ) {
        return reject('only the user may register their devices');
      }
      if (existing && (existing.body as RecordBodies['device']).revoked)
        return reject('device was revoked');
      return { ok: true, authorId };
    }
    case 'space': {
      const body = record.body as SpaceBody;
      const spaceId = parts[1]!;
      if (parts.length !== 2) return reject('bad space key');
      const authority = body.authority;
      if (authority && !spaceAuthorityValid(spaceId, body))
        return reject('bad admin list signature');
      // An edit made under an admin list the owner has since replaced.
      const before = (existing?.body as SpaceBody | undefined)?.authority?.at ?? 0;
      if (authority && authority.at < before) return reject('the admin list has changed');
      // Those let in by an admin stay, so the admins the owner has removed are only added to.
      const kept = new Set(body.formerAdmins ?? []);
      if ((existing?.body as SpaceBody | undefined)?.formerAdmins?.some((u) => !kept.has(u)))
        return reject('former admins cannot be taken off the list');
      if (body.owner === authorId) {
        if (spaceIdFor(record.author, body.nonce) !== spaceId)
          return reject('space id does not match owner');
        return { ok: true, authorId };
      }
      // An admin: allowed by the owner's signed list, carried in the record itself.
      if (!authority || !body.admins.includes(authorId))
        return reject('only the owner or an admin may change a space');
      if (body.deleted || (existing?.body as SpaceBody | undefined)?.deleted)
        return reject('only the owner may delete a space');
      if (body.bans.some((u) => u === body.owner || body.admins.includes(u)))
        return reject('admins cannot ban the owner or other admins');
      return { ok: true, authorId };
    }
    case 'invite': {
      const body = record.body as RecordBodies['invite'];
      if (parts.length !== 2 || body.code !== parts[1]) return reject('invite key mismatch');
      const space = ctx.get(`space:${body.spaceId}`) as SignedRecord<'space'> | undefined;
      if (!space) return reject('unknown space', true);
      const before = existing?.body as RecordBodies['invite'] | undefined;
      if (before && before.spaceId !== body.spaceId) return reject('invite code already used');
      if (body.tpub !== undefined) {
        // A ticket is the open link: its name is the hash of its key, and it is not for a person.
        if (body.for !== undefined) return reject('a ticket is for the open link');
        if (body.code !== ticketIdOf(body.tpub))
          return reject('invite name does not match its key');
      }
      if (before && before.tpub !== body.tpub) return reject('an invite cannot change its ticket');
      if (body.for !== undefined) {
        if (!USER_ID.test(body.for)) return reject('bad invite recipient');
        if (body.for === authorId) return reject('an invite is for somebody else');
        // It lapses: a named invitation does not wait for ever.
        if (
          body.expiresAt === null ||
          body.expiresAt > ctx.now + INVITE_MAX_MS + INVITE_CLOCK_SLACK_MS
        )
          return reject('an invitation to a person needs an end, within 30 days');
      } else if (ctx.fresh && !body.revoked) {
        // The open invite too, when it is made (those already made, without an end, stay as they
        // were, and so does their withdrawal).
        if (
          body.expiresAt === null ||
          body.expiresAt > ctx.now + INVITE_MAX_MS + INVITE_CLOCK_SLACK_MS
        )
          return reject('an invite needs an end, within 30 days');
        if (body.code.length < OPEN_CODE_LENGTH)
          return reject('the code of an open link is too short');
      }
      // The owner and current admins make and revoke invites. (A removed
      // admin's invites stop working anyway; see 'member' below.)
      if (!canManageSpace(space.body, authorId)) {
        // Its maker may always withdraw an invitation, whatever the space allows now.
        const withdrawing =
          !!existing &&
          existing.author === record.author &&
          body.revoked === true &&
          body.for !== undefined &&
          before?.for === body.for;
        if (!withdrawing) {
          // A named person may also be invited by a member, where the space allows it. Whether the
          // author is one can be told only by those who hold the space's member list; the others
          // take the word of the server that took the invite, as for an invite's expiry.
          if (body.for === undefined || !mayInviteByName(space.body, authorId))
            return reject('only the space owner or an admin may create invites');
          if (ctx.fresh && !isSpaceMember(ctx, body.spaceId, authorId))
            return reject('only a member of the space may invite');
          // An invite is changed by its maker or by the owner and admins.
          if (existing && existing.author !== record.author)
            return reject('only its maker, the owner or an admin may change an invite');
        }
      }
      // Who an invite is for does not change: a new invite is a new code.
      if (before && before.for !== body.for) return reject('an invite cannot change who it is for');
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
      if (ctx.fresh && space.body.bans.includes(authorId))
        return reject('you are banned from this space');
      if (body.ticket) {
        if (body.inviteCode)
          return reject('a membership uses a ticket or an invite code, not both');
        const problem = ticketProblem(body.spaceId, space.body, body);
        if (problem) return reject(problem);
        if (ctx.fresh) {
          const tid = body.ticket.invite.body.code;
          const invite = ctx.get(`invite:${tid}`) as SignedRecord<'invite'> | undefined;
          if (!invite) return reject('unknown invite', true);
          if (invite.body.tpub !== body.ticket.invite.body.tpub)
            return reject('ticket does not match its invite');
          if (invite.body.revoked) return reject('invite was revoked');
          if (space.body.publicInvite !== tid)
            return reject('this link has been replaced or turned off');
          if (invite.body.expiresAt === null)
            return reject('this link is out of date; make a new one');
          if (!canManageSpace(space.body, userIdFromKey(invite.author)))
            return reject('invite was made by someone who may no longer invite');
          if (invite.body.expiresAt < ctx.now) return reject('invite expired');
        }
        return { ok: true, authorId };
      }
      // Re-signing an existing active membership (e.g. rejoin after leave) needs a valid invite too.
      if (!body.inviteCode) return reject('an invite is required');
      const invite = ctx.get(`invite:${body.inviteCode}`) as SignedRecord<'invite'> | undefined;
      if (!invite) return reject('unknown invite', true);
      if (invite.body.spaceId !== body.spaceId) return reject('invite is for another space');
      // A ticket is used with its secret, never by naming it: its name is in the space record.
      if (invite.body.tpub !== undefined) return reject('this invite is used with its ticket');
      if (invite.body.for !== undefined && invite.body.for !== authorId)
        return reject('invite is for somebody else');
      if (ctx.fresh) {
        if (invite.body.revoked) return reject('invite was revoked');
        // The open invite is the one the space names; a newer one has replaced the rest.
        if (
          invite.body.for === undefined &&
          space.body.publicInvite !== inviteCommitment(body.spaceId, invite.body.code)
        )
          return reject('this link has been replaced or turned off');
        // Nor is one that never ends the open link, however the space came to name it.
        if (
          invite.body.for === undefined &&
          (invite.body.expiresAt === null || invite.body.code.length < OPEN_CODE_LENGTH)
        )
          return reject('this link is out of date; make a new one');
        // An invite from someone who may no longer make it stops working: an admin who was
        // removed, or, for a named person, a member where the space no longer allows that.
        const maker = userIdFromKey(invite.author);
        if (
          !canManageSpace(space.body, maker) &&
          !(
            invite.body.for !== undefined &&
            mayInviteByName(space.body, maker) &&
            isSpaceMember(ctx, body.spaceId, maker)
          )
        )
          return reject('invite was made by someone who may no longer invite');
        if (invite.body.expiresAt !== null && invite.body.expiresAt < ctx.now)
          return reject('invite expired');
      }
      return { ok: true, authorId };
    }
    case 'note': {
      const body = record.body as RecordBodies['note'];
      const [, to, noteId] = parts;
      if (parts.length !== 3 || !USER_ID.test(to!) || !USER_ID.test(noteId!))
        return reject('bad note key');
      // Replicated or not: an expired note can't come back.
      if (record.version < ctx.now - NOTE_TTL_MS) return reject('note expired');
      if (body.deleted) {
        if (authorId !== to) return reject('only the recipient may delete a note');
        if (body.boxes.length) return reject('a deleted note carries nothing');
        return { ok: true, authorId };
      }
      if (authorId !== noteId) return reject('note id does not match its key');
      // Written once, by a key used for nothing else.
      if (existing) return reject('note already exists');
      const recipient = ctx.get(`profile:${to}`) as SignedRecord<'profile'> | undefined;
      if (recipient?.body.deleted) return reject('account was deleted');
      // An empty one would only take a place in the recipient's quota.
      if (!body.boxes.length) return reject('a note carries at least one box');
      if (body.boxes.some((b) => peerIds.user(b.to) !== to))
        return reject('note boxes are for someone else');
      return { ok: true, authorId };
    }
  }
}

const USER_ID = /^[a-z2-7]{26}$/;

/** The longest an invite may last. */
export const INVITE_MAX_MS = 30 * 24 * 3600_000;
/** What a server lets an invite run over that, for a clock that is a little off. */
const INVITE_CLOCK_SLACK_MS = 24 * 3600_000;

/** May change the space: its owner, or one of its admins. */
export function canManageSpace(space: SpaceBody, userId: string): boolean {
  return space.owner === userId || (!!space.authority && space.admins.includes(userId));
}

function authorityPayload(
  spaceId: string,
  admins: string[],
  at: number,
  invitePolicy?: SpaceBody['invitePolicy'],
  formerAdmins?: string[],
) {
  // Members being let invite is the owner's to say, so it is in what the owner signs. (The
  // default is left out, which keeps what was signed before the setting existed valid.)
  const policy = signedInvitePolicy(invitePolicy);
  return {
    spaceId,
    admins,
    at,
    ...(policy ? { invitePolicy: policy } : {}),
    // (Also left out when there are none, so that what was signed before there were any stays valid.)
    ...(formerAdmins?.length ? { formerAdmins } : {}),
  };
}

/** The part of a space's invite policy the owner signs: only the one that is not the default. */
export function signedInvitePolicy(policy: SpaceBody['invitePolicy']): 'members' | undefined {
  return policy === 'members' ? 'members' : undefined;
}

/** The owner's signature on a space's admin list, for its `authority`. */
export function signSpaceAuthority(
  owner: Identity,
  spaceId: string,
  admins: string[],
  at: number,
  invitePolicy?: SpaceBody['invitePolicy'],
  formerAdmins?: string[],
): NonNullable<SpaceBody['authority']> {
  return {
    ownerKey: owner.publicKey,
    at,
    sig: sign(
      owner,
      SIG_DOMAIN.spaceAdmins,
      authorityPayload(spaceId, admins, at, invitePolicy, formerAdmins),
    ),
  };
}

/** The space's `authority` is the owner's signature on exactly its admin list. */
export function spaceAuthorityValid(spaceId: string, body: SpaceBody): boolean {
  const a = body.authority;
  if (!a) return false;
  try {
    if (userIdFromKey(a.ownerKey) !== body.owner) return false;
    if (spaceIdFor(a.ownerKey, body.nonce) !== spaceId) return false;
    return verifyPayload(
      a.ownerKey,
      SIG_DOMAIN.spaceAdmins,
      authorityPayload(spaceId, body.admins, a.at, body.invitePolicy, body.formerAdmins),
      a.sig,
    );
  } catch {
    return false;
  }
}

/**
 * May make an invitation to a named person, as far as the space record tells: the owner and
 * admins, and members where the space lets them. (That the maker is a member is for
 * those who hold the member list to check.)
 */
export function mayInviteByName(space: SpaceBody, userId: string): boolean {
  return canManageSpace(space, userId) || space.invitePolicy === 'members';
}

/** May have made a ticket that still admits those it let in: the owner, an admin, or a former one. */
export function mayHaveIssuedTicket(space: SpaceBody, userId: string): boolean {
  return (
    canManageSpace(space, userId) || (!!space.authority && !!space.formerAdmins?.includes(userId))
  );
}

/**
 * Why a member record's ticket does not admit its user to the space, if it does not. It needs no
 * clock and no other record, so that every server and app reaches the same answer; whether the
 * link is still on is for those who take a join as it is made.
 */
export function ticketProblem(
  spaceId: string,
  space: SpaceBody,
  member: RecordBodies['member'],
): string | undefined {
  const t = member.ticket;
  if (!t) return 'no ticket';
  const { invite } = t;
  if (invite.key !== recordKey.invite(invite.body.code)) return 'ticket does not match its invite';
  if (invite.body.spaceId !== spaceId) return 'invite is for another space';
  if (invite.body.tpub === undefined || invite.body.for !== undefined) return 'not a ticket';
  if (invite.body.code !== ticketIdOf(invite.body.tpub))
    return 'invite name does not match its key';
  if (invite.body.revoked) return 'invite was revoked';
  if (!verifyPayload(invite.author, SIG_DOMAIN.record, signedPart(invite), invite.sig))
    return 'bad signature on the ticket';
  if (!mayHaveIssuedTicket(space, userIdFromKey(invite.author)))
    return 'invite was made by someone who could not invite';
  if (
    !verifyPayload(
      invite.body.tpub,
      SIG_DOMAIN.ticketUse,
      ticketUsePayload(spaceId, invite.body.code, member.userId),
      t.proof,
    )
  )
    return 'the ticket was not used by this user';
  return undefined;
}

// A ticket is checked once for each member record against each space record it is met with.
const ticketChecked = new WeakMap<object, WeakMap<object, boolean>>();

/** True if the user currently belongs to the space (owner or active, non-banned member). */
export function isSpaceMember(lookup: RecordLookup, spaceId: string, userId: string): boolean {
  const space = lookup.get(`space:${spaceId}`) as SignedRecord<'space'> | undefined;
  if (!space || space.body.deleted) return false;
  if (space.body.owner === userId) return true;
  if (space.body.bans.includes(userId)) return false;
  const member = lookup.get(`member:${spaceId}:${userId}`) as SignedRecord<'member'> | undefined;
  if (!member || member.body.left) return false;
  if (!member.body.ticket) return true;
  // Who may have made the ticket is the space's to say now, whatever it said when this was taken.
  let bySpace = ticketChecked.get(member);
  if (!bySpace) ticketChecked.set(member, (bySpace = new WeakMap()));
  let ok = bySpace.get(space);
  if (ok === undefined)
    bySpace.set(space, (ok = ticketProblem(spaceId, space.body, member.body) === undefined));
  return ok;
}
