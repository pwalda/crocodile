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
  type RosterBody,
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

/**
 * What a space names its open link by: a link that is a ticket by its own name, an older one by a
 * hash of its code (the code being a secret).
 */
export function openLinkName(spaceId: string, code: string, isTicket: boolean): string {
  return isTicket ? code : inviteCommitment(spaceId, code);
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
  // (52 characters hold 260 bits: the 4 that are over must be 0, or one secret has many spellings.)
  if (seed.length !== 32 || toB32(seed) !== clean) return null;
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
      // The list means something only under the owner's signature.
      if (body.formerAdmins?.length && !authority)
        return reject("former admins need the owner's signature on the admin list");
      // Those let in by an admin stay, so the admins the owner has removed are only added to.
      // (A space that is deleted keeps nothing but what names it, so there is nobody to let in.)
      const kept = new Set(body.formerAdmins ?? []);
      if (
        !body.deleted &&
        (existing?.body as SpaceBody | undefined)?.formerAdmins?.some((u) => !kept.has(u))
      )
        return reject('former admins cannot be taken off the list');
      // Nor is the roster, once the owner has signed it: that would let in those it left out.
      const rostered = (existing?.body as SpaceBody | undefined)?.authority?.roster;
      if (!body.deleted && rostered && authority?.roster !== rostered)
        return reject('the roster of a space cannot be changed or taken off');
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
    case 'roster': {
      const body = record.body as RosterBody;
      if (parts.length !== 2 || parts[1] !== body.spaceId) return reject('roster key mismatch');
      const space = ctx.get(`space:${body.spaceId}`) as SignedRecord<'space'> | undefined;
      if (!space) return reject('unknown space', true);
      if (authorId !== space.body.owner) return reject('only the owner may sign a roster');
      // In one order, each once: the hash the space names it by is then of one list only.
      if (!body.members.every((u, i) => USER_ID.test(u) && (i === 0 || body.members[i - 1]! < u)))
        return reject('a roster lists each member once, in order');
      const named = space.body.authority?.roster;
      if (named && named !== rosterHash(body.spaceId, body.members))
        return reject('this is not the roster the space names');
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
        // The open link is a ticket, whose secret no record holds; a code anyone could read in a
        // member list is no longer made (those already made stay as they were, and so does their
        // withdrawal).
        if (body.tpub === undefined) return reject('an open link is made as a ticket');
        if (
          body.expiresAt === null ||
          body.expiresAt > ctx.now + INVITE_MAX_MS + INVITE_CLOCK_SLACK_MS
        )
          return reject('an invite needs an end, within 30 days');
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
        // (Not for a write straight from its author: it is told, and can write again.)
        if (problem) return reject(problem.reason, problem.retryable && !ctx.fresh);
        if (ctx.fresh) {
          const tid = body.ticket.invite.body.code;
          const invite = ctx.get(`invite:${tid}`) as SignedRecord<'invite'> | undefined;
          if (!invite) return reject('unknown invite', true);
          if (
            invite.body.tpub !== body.ticket.invite.body.tpub ||
            invite.body.spaceId !== body.spaceId
          )
            return reject('ticket does not match its invite');
          if (invite.body.revoked) return reject('invite was revoked');
          if (space.body.publicInvite !== openLinkName(body.spaceId, tid, true))
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
      // An open link of the older kind is read from a member list by anyone in the space, and
      // so is no way in any more. (The members it let in stay if the owner's roster lists them.)
      if (ctx.fresh && invite.body.for === undefined)
        return reject('this link is out of date; ask for a new one');
      const problem = legacyMembershipProblem(ctx, body.spaceId, space.body, body);
      if (problem) return reject(problem.reason, problem.retryable && !ctx.fresh);
      if (ctx.fresh) {
        if (invite.body.revoked) return reject('invite was revoked');
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
  roster?: string,
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
    ...(roster ? { roster } : {}),
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
  roster?: string,
): NonNullable<SpaceBody['authority']> {
  return {
    ownerKey: owner.publicKey,
    at,
    sig: sign(
      owner,
      SIG_DOMAIN.spaceAdmins,
      authorityPayload(spaceId, admins, at, invitePolicy, formerAdmins, roster),
    ),
    ...(roster ? { roster } : {}),
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
      authorityPayload(spaceId, body.admins, a.at, body.invitePolicy, body.formerAdmins, a.roster),
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
 * clock and no other record than the space; whether the link is still on is for those who take a
 * join as it is made.
 */
export function ticketProblem(
  spaceId: string,
  space: SpaceBody,
  member: RecordBodies['member'],
): { reason: string; retryable?: boolean } | undefined {
  const t = member.ticket;
  if (!t) return { reason: 'no ticket' };
  const intact = ticketIntact(spaceId, member);
  if (intact.reason) return { reason: intact.reason };
  // Whether its maker may have made it is for the space to say, and it can change.
  if (!mayHaveIssuedTicket(space, intact.maker))
    // (The space we hold may be older than the one that lists the maker: try again later.)
    return { reason: 'invite was made by someone who could not invite', retryable: true };
  return undefined;
}

// What does not depend on the space (the signatures, and who signed) is found once for each membership.
const ticketSigned = new WeakMap<object, { reason?: string; maker: string }>();

function ticketIntact(spaceId: string, member: RecordBodies['member']) {
  // (What is checked is the membership as it names its space; asked about another, it is not that.)
  if (spaceId !== member.spaceId) return { reason: 'invite is for another space', maker: '' };
  let found = ticketSigned.get(member);
  if (!found) {
    const reason = ticketBroken(spaceId, member);
    // (Who signed is looked for only in a ticket that is sound.)
    found = { reason, maker: reason ? '' : userIdFromKey(member.ticket!.invite.author) };
    ticketSigned.set(member, found);
  }
  return found;
}

function ticketBroken(spaceId: string, member: RecordBodies['member']): string | undefined {
  const t = member.ticket!;
  const { invite } = t;
  if (invite.key !== recordKey.invite(invite.body.code)) return 'ticket does not match its invite';
  if (invite.body.spaceId !== spaceId) return 'invite is for another space';
  if (invite.body.tpub === undefined || invite.body.for !== undefined) return 'not a ticket';
  if (invite.body.code !== ticketIdOf(invite.body.tpub))
    return 'invite name does not match its key';
  if (invite.body.revoked) return 'invite was revoked';
  if (!verifyPayload(invite.author, SIG_DOMAIN.record, signedPart(invite), invite.sig))
    return 'bad signature on the ticket';
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

/** What a roster is named by: a hash of who it lists, so that the space's signature covers the list. */
export function rosterHash(spaceId: string, members: string[]): string {
  return toB64u(sha256(utf8.encode(`croc/v1/roster\n${canonicalJson({ spaceId, members })}`)));
}

/** The owner's signed roster of those who stay (the members in order, each once). */
export function signRoster(
  owner: Identity,
  spaceId: string,
  members: string[],
  at = Date.now(),
): { record: SignedRecord<'roster'>; hash: string } {
  const list = [...new Set(members)].sort();
  return {
    record: signRecord(owner, 'roster', recordKey.roster(spaceId), { spaceId, members: list, at }),
    hash: rosterHash(spaceId, list),
  };
}

const NOBODY: ReadonlySet<string> = new Set();
const emptyRosters = new Map<string, string>();
/** The hash a space names a roster of nobody by (which needs no record). */
export function emptyRosterHash(spaceId: string): string {
  let hash = emptyRosters.get(spaceId);
  if (!hash) {
    if (emptyRosters.size >= 1000) emptyRosters.clear();
    hash = rosterHash(spaceId, []);
    emptyRosters.set(spaceId, hash);
  }
  return hash;
}

// What a roster holds is worked out once for each record held, not for each question put to it.
const rosterMembers = new WeakMap<object, { hash: string; members: Set<string>; owner: string }>();

/**
 * Who the roster the space names lists: undefined if it names none (older memberships count as
 * they always did), nobody if it names the empty one, and `null` if it names one not held.
 */
export function rosterOf(
  lookup: RecordLookup,
  spaceId: string,
  space: SpaceBody,
): ReadonlySet<string> | null | undefined {
  const named = space.authority?.roster;
  if (!named) return undefined;
  if (named === emptyRosterHash(spaceId)) return NOBODY;
  const record = lookup.get(recordKey.roster(spaceId)) as SignedRecord<'roster'> | undefined;
  if (!record || record.body.spaceId !== spaceId) return null;
  let found = rosterMembers.get(record);
  if (!found) {
    found = {
      hash: rosterHash(spaceId, record.body.members),
      members: new Set(record.body.members),
      owner: userIdFromKey(record.author),
    };
    rosterMembers.set(record, found);
  }
  return found.hash === named && found.owner === space.owner ? found.members : null;
}

/**
 * The key of the roster a membership of the older kind (a code, no ticket) is checked against, if
 * the space it is for names one that is not empty (a roster of nobody needs no record).
 */
export function rosterKeyOf(
  spaceId: string,
  space: SpaceBody | undefined,
  member: RecordBodies['member'],
): string | undefined {
  if (member.left || member.ticket) return undefined;
  const named = space?.authority?.roster;
  return named && named !== emptyRosterHash(spaceId) ? recordKey.roster(spaceId) : undefined;
}

/**
 * Why a membership of the older kind (an invite code, no ticket) does not count, if it does not.
 * A space whose owner has signed a roster takes it only for those on the roster, and for those
 * a named invitation was made for; before that it counts as it always did.
 */
export function legacyMembershipProblem(
  lookup: RecordLookup,
  spaceId: string,
  space: SpaceBody,
  member: RecordBodies['member'],
): { reason: string; retryable?: boolean } | undefined {
  const roster = rosterOf(lookup, spaceId, space);
  if (roster === undefined || roster?.has(member.userId)) return undefined;
  // (A named invitation is a proof of its own: the invite is for this user and nobody else.)
  const invite = member.inviteCode
    ? (lookup.get(recordKey.invite(member.inviteCode)) as SignedRecord<'invite'> | undefined)
    : undefined;
  if (invite?.body.spaceId === spaceId && invite.body.for === member.userId) return undefined;
  if (roster === null)
    return { reason: "the owner's list of members is not here yet", retryable: true };
  return { reason: 'this link is out of date; ask for a new one' };
}

/** True if the user currently belongs to the space (owner or active, non-banned member). */
export function isSpaceMember(lookup: RecordLookup, spaceId: string, userId: string): boolean {
  const space = lookup.get(`space:${spaceId}`) as SignedRecord<'space'> | undefined;
  if (!space || space.body.deleted) return false;
  if (space.body.owner === userId) return true;
  if (space.body.bans.includes(userId)) return false;
  const member = lookup.get(`member:${spaceId}:${userId}`) as SignedRecord<'member'> | undefined;
  if (!member || member.body.left) return false;
  if (!member.body.ticket)
    return !legacyMembershipProblem(lookup, spaceId, space.body, member.body);
  // Who may have made the ticket is the space's to say now, whatever it said when this was taken.
  return !ticketProblem(spaceId, space.body, member.body);
}
