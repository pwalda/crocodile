import { describe, expect, it } from 'vitest';
import {
  AnonBox,
  DELETED_PROFILE_NAME,
  NOTE_TTL_MS,
  recordKey,
  SIG_DOMAIN,
  sessionOpPayload,
  type HostCaps,
  type SessionOpProof,
  type SignedRecord,
  type SpaceBody,
  utf8,
} from '@crocodile/protocol';
import {
  AudioReceiver,
  AudioSender,
  PREKEY_LIFETIME_MS,
  SecureChannel,
  TextReceiver,
  VIDEO_MAX_CLEAR,
  VideoReceiver,
  VideoSender,
  acceptChannel,
  answerChannel,
  createChannelKeys,
  createLinkKem,
  createPrekey,
  encryptText,
  exportChains,
  importChain,
  linkCommitment,
  linkCommitmentValid,
  linkNonce,
  linkSecurityCode,
  openAnonymous,
  openForSelf,
  openLink,
  padmeLength,
  ratchet,
  rotatePrekeys,
  sealAnonymous,
  sealForSelf,
  sealLink,
  sealToDevice,
  userIdFromKey,
  createChatMessage,
  createIdentity,
  signSessionOp,
  verifySessionOp,
  createSenderKey,
  decodeRecoveryKey,
  encodeRecoveryKey,
  fileIdFor,
  identityFromSeed,
  isSpaceMember,
  newFileKey,
  openSealed,
  peekFrameKid,
  randomId,
  safetyNumber,
  sign,
  signRecord,
  signSdp,
  signSpaceAuthority,
  inviteCommitment,
  newTicket,
  signTicketUse,
  spaceAuthorityValid,
  spaceIdFor,
  ticketFromSecret,
  validateRecord,
  verifyChatMessage,
  verifyPayload,
  verifySdp,
  type ValidationContext,
} from '../src';

function ctx(records: SignedRecord[], fresh = true): ValidationContext {
  const map = new Map(records.map((r) => [r.key, r]));
  return { get: (k) => map.get(k), now: Date.now(), fresh };
}

describe('identity', () => {
  it('recovers the same identity from the recovery key', () => {
    const id = createIdentity();
    const key = encodeRecoveryKey(id.seed);
    expect(key).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    const restored = identityFromSeed(decodeRecoveryKey(key.toLowerCase()));
    expect(restored.userId).toBe(id.userId);
    expect(restored.encPublicKey).toBe(id.encPublicKey);
  });

  it('rejects a mistyped recovery key', () => {
    const key = encodeRecoveryKey(createIdentity().seed);
    const typo = (key[0] === 'A' ? 'B' : 'A') + key.slice(1);
    expect(() => decodeRecoveryKey(typo)).toThrow(/checksum/);
  });

  it('safety numbers are symmetric', () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(safetyNumber(a.publicKey, b.publicKey)).toBe(safetyNumber(b.publicKey, a.publicKey));
    expect(safetyNumber(a.publicKey, b.publicKey)).toMatch(/^(\d{5} ){11}\d{5}$/);
  });
});

describe('records', () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const mallory = createIdentity();

  const profile = (who = alice) =>
    signRecord(who, 'profile', recordKey.profile(who.userId), {
      username: 'alice',
      encKey: who.encPublicKey,
    });

  it('accepts a self-signed profile and rejects forgeries', () => {
    expect(validateRecord(profile(), ctx([])).ok).toBe(true);
    const forged = signRecord(mallory, 'profile', recordKey.profile(alice.userId), {
      username: 'alice',
      encKey: mallory.encPublicKey,
    });
    expect(validateRecord(forged, ctx([]))).toMatchObject({ ok: false });
    const tampered = { ...profile(), body: { username: 'eve', encKey: alice.encPublicKey } };
    expect(validateRecord(tampered, ctx([]))).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  it('enforces last-writer-wins versions', () => {
    const v1 = signRecord(
      alice,
      'profile',
      recordKey.profile(alice.userId),
      { username: 'a', encKey: alice.encPublicKey },
      Date.now() - 1000,
    );
    const v2 = signRecord(alice, 'profile', recordKey.profile(alice.userId), {
      username: 'b',
      encKey: alice.encPublicKey,
    });
    expect(validateRecord(v1, ctx([v2]))).toMatchObject({ ok: false, reason: 'stale version' });
    expect(validateRecord(v2, ctx([v1])).ok).toBe(true);
  });

  it('a deleted account is a bare marker and signs nothing more', () => {
    const deleted = (body: Record<string, unknown> = {}, version = Date.now()) =>
      signRecord(
        alice,
        'profile',
        recordKey.profile(alice.userId),
        { username: DELETED_PROFILE_NAME, encKey: alice.encPublicKey, deleted: true, ...body },
        version,
      );
    const before = signRecord(
      alice,
      'profile',
      recordKey.profile(alice.userId),
      { username: 'alice', encKey: alice.encPublicKey },
      Date.now() - 5000,
    );
    expect(validateRecord(deleted(), ctx([before])).ok).toBe(true);
    expect(validateRecord(deleted({ bio: 'still here' }), ctx([]))).toMatchObject({
      ok: false,
      reason: 'a deleted profile carries no details',
    });
    expect(validateRecord(deleted({ username: 'alice' }), ctx([]))).toMatchObject({ ok: false });

    const marker = deleted({}, Date.now() - 1000);
    // Not even a newer profile brings the account back...
    expect(validateRecord(profile(), ctx([marker]))).toMatchObject({
      ok: false,
      reason: 'account was deleted',
    });
    // ...and nothing else it signs is accepted.
    const friends = signRecord(alice, 'friends', recordKey.friends(alice.userId), {
      friends: [bob.userId],
      blocked: [],
    });
    expect(validateRecord(friends, ctx([marker]))).toMatchObject({
      ok: false,
      reason: 'account was deleted',
    });
    // Other people are unaffected.
    expect(validateRecord(profile(bob), ctx([marker])).ok).toBe(true);
  });

  it('binds spaces to their owner and gates membership on invites', () => {
    const nonce = randomId();
    const spaceId = spaceIdFor(alice.publicKey, nonce);
    const code = randomId(16);
    const space = signRecord(alice, 'space', recordKey.space(spaceId), {
      name: 'Swamp',
      owner: alice.userId,
      nonce,
      admins: [],
      bans: [],
      publicInvite: inviteCommitment(spaceId, code),
      channels: [{ id: randomId(), name: 'general', kind: 'text' }],
    });
    expect(validateRecord(space, ctx([])).ok).toBe(true);

    const hijack = signRecord(mallory, 'space', recordKey.space(spaceId), {
      ...space.body,
      owner: mallory.userId,
    });
    expect(validateRecord(hijack, ctx([space])).ok).toBe(false);

    const invite = signRecord(alice, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: Date.now() + 7 * 24 * 3600_000,
    });
    expect(validateRecord(invite, ctx([space])).ok).toBe(true);
    const fakeInvite = signRecord(mallory, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: Date.now() + 7 * 24 * 3600_000,
    });
    expect(validateRecord(fakeInvite, ctx([space])).ok).toBe(false);

    const join = signRecord(bob, 'member', recordKey.member(spaceId, bob.userId), {
      spaceId,
      userId: bob.userId,
      inviteCode: code,
    });
    expect(validateRecord(join, ctx([space])).ok).toBe(false);
    expect(validateRecord(join, ctx([space, invite])).ok).toBe(true);
    const noInvite = signRecord(mallory, 'member', recordKey.member(spaceId, mallory.userId), {
      spaceId,
      userId: mallory.userId,
    });
    expect(validateRecord(noInvite, ctx([space, invite])).ok).toBe(false);

    const lookup = ctx([space, invite, join]);
    expect(isSpaceMember(lookup, spaceId, alice.userId)).toBe(true);
    expect(isSpaceMember(lookup, spaceId, bob.userId)).toBe(true);
    expect(isSpaceMember(lookup, spaceId, mallory.userId)).toBe(false);
  });

  describe('space admins', () => {
    const carol = createIdentity();
    const nonce = randomId();
    const spaceId = spaceIdFor(alice.publicKey, nonce);
    const key = recordKey.space(spaceId);
    const now = Date.now();
    const base = {
      name: 'Swamp',
      owner: alice.userId,
      nonce,
      bans: [] as string[],
      channels: [{ id: randomId(), name: 'general', kind: 'text' as const }],
    };
    /** Alice makes Bob an admin. */
    const withBob = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [bob.userId],
        authority: signSpaceAuthority(alice, spaceId, [bob.userId], now - 2000),
      },
      now - 2000,
    );

    it('leaves who may invite to the owner, bound into what the owner signs', () => {
      const byAdmin = signRecord(
        bob,
        'space',
        key,
        { ...withBob.body, invitePolicy: 'members' },
        now - 1000,
      );
      // Refused with the owner's earlier version to compare with, and without it.
      for (const known of [[withBob], []])
        expect(validateRecord(byAdmin, ctx(known))).toMatchObject({
          ok: false,
          reason: 'bad admin list signature',
        });
      // A change of name leaves it as it was, set or not.
      const renamed = signRecord(bob, 'space', key, { ...withBob.body, name: 'Pond' }, now - 1000);
      expect(validateRecord(renamed, ctx([withBob])).ok).toBe(true);
      // The owner signs it with the list, and an admin can then carry it on.
      const byOwner = signRecord(
        alice,
        'space',
        key,
        {
          ...withBob.body,
          invitePolicy: 'members',
          authority: signSpaceAuthority(alice, spaceId, [bob.userId], now - 900, 'members'),
        },
        now - 900,
      );
      expect(validateRecord(byOwner, ctx([withBob])).ok).toBe(true);
      const carried = signRecord(bob, 'space', key, { ...byOwner.body, name: 'Pond' }, now - 800);
      expect(validateRecord(carried, ctx([byOwner])).ok).toBe(true);
      expect(validateRecord(carried, ctx([])).ok).toBe(true);
      // An admin cannot take it away again, either.
      const taken = signRecord(
        bob,
        'space',
        key,
        { ...byOwner.body, invitePolicy: 'admins' },
        now - 700,
      );
      expect(validateRecord(taken, ctx([byOwner]))).toMatchObject({ ok: false });
    });

    it("lets an admin change the space, checked on its own, without the owner's record", () => {
      const renamed = signRecord(bob, 'space', key, { ...withBob.body, name: 'Pond' }, now - 1000);
      expect(validateRecord(renamed, ctx([withBob])).ok).toBe(true);
      // A server or client that never saw the owner's version can check it too.
      expect(validateRecord(renamed, ctx([])).ok).toBe(true);
      // Someone not on the owner's list can't, signature or not.
      const byMallory = signRecord(mallory, 'space', key, { ...withBob.body, name: 'Mine' });
      expect(validateRecord(byMallory, ctx([withBob]))).toMatchObject({ ok: false });
    });

    it('keeps the admin list, deletion and the owner out of admins’ hands', () => {
      const v = now - 1000;
      const promoted = signRecord(
        bob,
        'space',
        key,
        { ...withBob.body, admins: [bob.userId, mallory.userId] },
        v,
      );
      expect(validateRecord(promoted, ctx([withBob]))).toMatchObject({
        ok: false,
        reason: 'bad admin list signature',
      });
      const deleted = signRecord(bob, 'space', key, { ...withBob.body, deleted: true }, v);
      expect(validateRecord(deleted, ctx([withBob]))).toMatchObject({
        reason: 'only the owner may delete a space',
      });
      const banOwner = signRecord(bob, 'space', key, { ...withBob.body, bans: [alice.userId] }, v);
      expect(validateRecord(banOwner, ctx([withBob]))).toMatchObject({ ok: false });
      const banCarol = signRecord(bob, 'space', key, { ...withBob.body, bans: [carol.userId] }, v);
      expect(validateRecord(banCarol, ctx([withBob])).ok).toBe(true);
    });

    it('refuses an edit under an admin list the owner has replaced', () => {
      // Alice removes Bob; Bob still holds the old signed list.
      const without = signRecord(
        alice,
        'space',
        key,
        { ...base, admins: [], authority: signSpaceAuthority(alice, spaceId, [], now - 500) },
        now - 500,
      );
      const late = signRecord(bob, 'space', key, { ...withBob.body, name: 'Still mine' }, now);
      expect(validateRecord(late, ctx([without]))).toMatchObject({
        ok: false,
        reason: 'the admin list has changed',
      });
    });

    describe('private invites', () => {
      const dave = createIdentity();
      const eve = createIdentity();
      const memberOf = (who: typeof bob, inviteCode?: string) =>
        signRecord(who, 'member', recordKey.member(spaceId, who.userId), {
          spaceId,
          userId: who.userId,
          ...(inviteCode ? { inviteCode } : {}),
        });
      const privateInvite = (who: typeof bob, to: string, extra = {}) => {
        const code = randomId(5);
        return signRecord(who, 'invite', recordKey.invite(code), {
          spaceId,
          code,
          expiresAt: Date.now() + 7 * 24 * 3600_000,
          for: to,
          ...extra,
        });
      };
      const members = signRecord(
        alice,
        'space',
        key,
        { ...base, admins: [], invitePolicy: 'members' as const },
        now - 1500,
      );
      const admins = signRecord(
        alice,
        'space',
        key,
        { ...base, admins: [], invitePolicy: 'admins' as const },
        now - 1500,
      );
      const bobIsIn = memberOf(bob, 'x'.repeat(8));
      const fresh = (records: SignedRecord[]) => ({ ...ctx(records), fresh: true });

      it('can be joined with by the named person alone', () => {
        const invite = privateInvite(alice, dave.userId);
        const code = invite.body.code;
        expect(validateRecord(invite, ctx([admins])).ok).toBe(true);
        expect(validateRecord(memberOf(dave, code), fresh([admins, invite])).ok).toBe(true);
        // Anyone else, even holding the code, is refused, and no matter who checks.
        expect(validateRecord(memberOf(eve, code), fresh([admins, invite]))).toMatchObject({
          ok: false,
          reason: 'invite is for somebody else',
        });
        expect(validateRecord(memberOf(eve, code), ctx([admins, invite]))).toMatchObject({
          ok: false,
          reason: 'invite is for somebody else',
        });
      });

      it('lapse, within 30 days, and need not outlive a change of policy', () => {
        expect(
          validateRecord(privateInvite(alice, dave.userId, { expiresAt: null }), ctx([admins])),
        ).toMatchObject({ ok: false, reason: expect.stringMatching(/needs an end/) });
        const far = Date.now() + 32 * 24 * 3600_000;
        expect(
          validateRecord(privateInvite(alice, dave.userId, { expiresAt: far }), ctx([admins])),
        ).toMatchObject({ ok: false, reason: expect.stringMatching(/within 30 days/) });
        // The maker takes one back even after the space stops letting members invite.
        const byBob = privateInvite(bob, dave.userId);
        const withdraw = signRecord(
          bob,
          'invite',
          byBob.key,
          { ...byBob.body, revoked: true },
          byBob.version + 1,
        );
        expect(validateRecord(withdraw, fresh([admins, bobIsIn, byBob])).ok).toBe(true);
        // But not somebody else's, and not to change it.
        const other = signRecord(
          carol,
          'invite',
          byBob.key,
          { ...byBob.body, revoked: true },
          byBob.version + 1,
        );
        expect(validateRecord(other, fresh([admins, bobIsIn, byBob]))).toMatchObject({ ok: false });
      });

      it('names somebody else, and a person never changes', () => {
        expect(validateRecord(privateInvite(alice, alice.userId), ctx([admins]))).toMatchObject({
          ok: false,
          reason: 'an invite is for somebody else',
        });
        expect(validateRecord(privateInvite(alice, 'abcdefgh'), ctx([admins]))).toMatchObject({
          ok: false,
          reason: 'bad invite recipient',
        });
        const invite = privateInvite(alice, dave.userId);
        const redirected = signRecord(
          alice,
          'invite',
          invite.key,
          { ...invite.body, for: eve.userId },
          invite.version + 1,
        );
        expect(validateRecord(redirected, ctx([admins, invite]))).toMatchObject({
          ok: false,
          reason: 'an invite cannot change who it is for',
        });
        const opened = signRecord(
          alice,
          'invite',
          invite.key,
          { ...invite.body, for: undefined },
          invite.version + 1,
        );
        expect(validateRecord(opened, ctx([admins, invite]))).toMatchObject({ ok: false });
      });

      it('are made by members only where the space allows it', () => {
        const byBob = privateInvite(bob, dave.userId);
        // Where only the owner and admins invite, a member may not, and may not name a person either.
        expect(validateRecord(byBob, fresh([admins, bobIsIn]))).toMatchObject({
          ok: false,
          reason: 'only the space owner or an admin may create invites',
        });
        expect(validateRecord(byBob, fresh([members, bobIsIn])).ok).toBe(true);
        // Not a member: refused by the server that takes it, whatever the policy.
        expect(validateRecord(byBob, fresh([members]))).toMatchObject({
          ok: false,
          reason: 'only a member of the space may invite',
        });
        // The open invite stays with the owner and admins.
        const code = randomId(5);
        const open = signRecord(bob, 'invite', recordKey.invite(code), {
          spaceId,
          code,
          expiresAt: null,
        });
        expect(validateRecord(open, fresh([members, bobIsIn]))).toMatchObject({ ok: false });
        // Only its maker, the owner or an admin changes a member's invite.
        const revokeBy = (who: typeof bob) =>
          signRecord(who, 'invite', byBob.key, { ...byBob.body, revoked: true }, byBob.version + 1);
        const carolIn = memberOf(carol, 'x'.repeat(8));
        expect(
          validateRecord(revokeBy(carol), fresh([members, bobIsIn, carolIn, byBob])),
        ).toMatchObject({
          ok: false,
        });
        expect(validateRecord(revokeBy(bob), fresh([members, bobIsIn, byBob])).ok).toBe(true);
        expect(validateRecord(revokeBy(alice), fresh([members, bobIsIn, byBob])).ok).toBe(true);
      });

      it('stop working when the space no longer lets the maker invite, or the maker leaves', () => {
        const byBob = privateInvite(bob, dave.userId);
        const join = memberOf(dave, byBob.body.code);
        expect(validateRecord(join, fresh([members, bobIsIn, byBob])).ok).toBe(true);
        expect(validateRecord(join, fresh([admins, bobIsIn, byBob]))).toMatchObject({
          ok: false,
          reason: 'invite was made by someone who may no longer invite',
        });
        const bobLeft = signRecord(bob, 'member', recordKey.member(spaceId, bob.userId), {
          spaceId,
          userId: bob.userId,
          left: true,
        });
        expect(validateRecord(join, fresh([members, bobLeft, byBob]))).toMatchObject({
          ok: false,
          reason: 'invite was made by someone who may no longer invite',
        });
      });
    });

    it("lets admins make invites, which stop working when they're no longer admins", () => {
      const code = randomId(16);
      const invite = signRecord(bob, 'invite', recordKey.invite(code), {
        spaceId,
        code,
        expiresAt: now + 7 * 24 * 3600_000,
      });
      expect(validateRecord(invite, ctx([withBob])).ok).toBe(true);
      // The space names it as its open invite (the admin's edit carries the owner's list on).
      const named = signRecord(
        bob,
        'space',
        key,
        { ...withBob.body, publicInvite: inviteCommitment(spaceId, code) },
        now - 900,
      );
      const join = signRecord(carol, 'member', recordKey.member(spaceId, carol.userId), {
        spaceId,
        userId: carol.userId,
        inviteCode: code,
      });
      expect(validateRecord(join, { ...ctx([named, invite]), fresh: true }).ok).toBe(true);
      const without = signRecord(
        alice,
        'space',
        key,
        {
          ...base,
          admins: [],
          publicInvite: inviteCommitment(spaceId, code),
          authority: signSpaceAuthority(alice, spaceId, [], now - 500),
        },
        now - 500,
      );
      expect(validateRecord(join, { ...ctx([without, invite]), fresh: true })).toMatchObject({
        ok: false,
        reason: 'invite was made by someone who may no longer invite',
      });
      // Revoking it is the owner's (or a current admin's) to do, checked
      // with nothing but the space: no earlier invite needed.
      const revoke = (who: typeof bob) =>
        signRecord(who, 'invite', recordKey.invite(code), { ...invite.body, revoked: true });
      expect(validateRecord(revoke(bob), ctx([without]))).toMatchObject({ ok: false });
      expect(validateRecord(revoke(alice), ctx([without])).ok).toBe(true);
    });

    describe('the open invite', () => {
      const code = randomId(16);
      const other = randomId(16);
      const week = 7 * 24 * 3600_000;
      const named = signRecord(
        alice,
        'space',
        key,
        { ...base, admins: [], publicInvite: inviteCommitment(spaceId, code) },
        now - 800,
      );
      const open = (c: string, expiresAt: number | null, who = alice) =>
        signRecord(who, 'invite', recordKey.invite(c), { spaceId, code: c, expiresAt });
      const join = (c: string) =>
        signRecord(carol, 'member', recordKey.member(spaceId, carol.userId), {
          spaceId,
          userId: carol.userId,
          inviteCode: c,
        });

      it('is the one the space names, and joining with another is refused', () => {
        const a = open(code, now + week);
        const b = open(other, now + week);
        expect(validateRecord(join(code), ctx([named, a])).ok).toBe(true);
        expect(validateRecord(join(other), ctx([named, b]))).toMatchObject({
          ok: false,
          reason: 'this link has been replaced or turned off',
        });
        // No link on at all.
        const off = signRecord(alice, 'space', key, { ...base, admins: [] }, now - 700);
        expect(validateRecord(join(code), ctx([off, a]))).toMatchObject({ ok: false });
        // Only those taking a join as it is made look at that: a membership already made is
        // still a member when the link is replaced.
        expect(validateRecord(join(other), ctx([named, b], false)).ok).toBe(true);
      });

      it('is never one with no end or a short code, however the space came to name it', () => {
        const legacy = open(code, null);
        expect(validateRecord(join(code), ctx([named, legacy]))).toMatchObject({
          ok: false,
          reason: 'this link is out of date; make a new one',
        });
        const shortCode = randomId(5);
        const shortNamed = signRecord(
          alice,
          'space',
          key,
          { ...base, admins: [], publicInvite: inviteCommitment(spaceId, shortCode) },
          now - 790,
        );
        expect(
          validateRecord(join(shortCode), ctx([shortNamed, open(shortCode, now + week)])),
        ).toMatchObject({ ok: false, reason: 'this link is out of date; make a new one' });
        // Nor can one be made.
        expect(validateRecord(open(shortCode, now + week), ctx([shortNamed]))).toMatchObject({
          ok: false,
          reason: 'the code of an open link is too short',
        });
      });

      it('ends within 30 days when it is made, and what was made before stays as it was', () => {
        const month = 32 * 24 * 3600_000;
        for (const expiresAt of [null, now + month])
          expect(validateRecord(open(code, expiresAt), ctx([named]))).toMatchObject({
            ok: false,
            reason: 'an invite needs an end, within 30 days',
          });
        expect(validateRecord(open(code, now + week), ctx([named])).ok).toBe(true);
        // A clock a little ahead of the server's does not turn the full 30 days away.
        expect(
          validateRecord(open(code, now + 30 * 24 * 3600_000 + 3600_000), ctx([named])).ok,
        ).toBe(true);
        // Seen again later, or withdrawn, it is not turned away for lacking an end.
        expect(validateRecord(open(code, null), ctx([named], false)).ok).toBe(true);
        const withdrawn = signRecord(alice, 'invite', recordKey.invite(code), {
          spaceId,
          code,
          expiresAt: null,
          revoked: true,
        });
        expect(validateRecord(withdrawn, ctx([named])).ok).toBe(true);
      });
    });
  });
});

describe('open link tickets', () => {
  const alice = createIdentity();
  const bob = createIdentity();
  const carol = createIdentity();
  const dave = createIdentity();
  const mallory = createIdentity();
  const nonce = randomId();
  const spaceId = spaceIdFor(alice.publicKey, nonce);
  const key = recordKey.space(spaceId);
  const now = Date.now();
  const week = 7 * 24 * 3600_000;
  const base = {
    name: 'Swamp',
    owner: alice.userId,
    nonce,
    bans: [] as string[],
    channels: [{ id: randomId(), name: 'general', kind: 'text' as const }],
  };
  const ticket = newTicket();

  const space = (over: Partial<SpaceBody> = {}, version = now - 1000) =>
    signRecord(
      alice,
      'space',
      key,
      { ...base, admins: [], publicInvite: ticket.tid, ...over },
      version,
    );
  const invite = (who = alice, over: Record<string, unknown> = {}, t = ticket) =>
    signRecord(who, 'invite', recordKey.invite(t.tid), {
      spaceId,
      code: t.tid,
      tpub: t.tpub,
      expiresAt: now + week,
      ...over,
    });
  const joinWith = (
    who: typeof carol,
    inv: SignedRecord<'invite'>,
    t: { secret: string; tid: string } = ticket,
    extra: Record<string, unknown> = {},
  ) =>
    signRecord(who, 'member', recordKey.member(spaceId, who.userId), {
      spaceId,
      userId: who.userId,
      ticket: { invite: inv, proof: signTicketUse(t, spaceId, who.userId) },
      ...extra,
    });

  it('stands for a secret that is only in the link', () => {
    expect(ticket.secret).toHaveLength(52);
    expect(ticket.tid).toMatch(/^[a-z2-7]{26}$/);
    // The link gives the whole ticket back, in any case; the name gives nothing away.
    expect(ticketFromSecret(ticket.secret.toUpperCase())).toEqual(ticket);
    expect(ticket.tid).not.toContain(ticket.secret.slice(0, 8));
    expect(ticketFromSecret(ticket.secret.slice(1))).toBeNull();
    // One spelling for one secret: the bits of the last character beyond the 256 are 0.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const last = alphabet.indexOf(ticket.secret.at(-1)!);
    expect(ticketFromSecret(ticket.secret.slice(0, -1) + alphabet[last ^ 1])).toBeNull();
    expect(ticketFromSecret('1'.repeat(52))).toBeNull();
    expect(newTicket().secret).not.toBe(ticket.secret);
  });

  it('admits a member who holds the link, on every path, without the invite record', () => {
    const inv = invite();
    const join = joinWith(carol, inv);
    expect(validateRecord(join, ctx([space(), inv])).ok).toBe(true);
    // A replicating server or an app does not have to find the invite: the member record carries it.
    expect(validateRecord(join, ctx([space()], false)).ok).toBe(true);
    expect(isSpaceMember(ctx([space(), join]), spaceId, carol.userId)).toBe(true);
  });

  it('is not given away by the records: another user cannot use what one user signed', () => {
    const inv = invite();
    const carols = joinWith(carol, inv);
    const stolen = signRecord(dave, 'member', recordKey.member(spaceId, dave.userId), {
      spaceId,
      userId: dave.userId,
      ticket: carols.body.ticket!,
    });
    expect(validateRecord(stolen, ctx([space()], false))).toMatchObject({
      ok: false,
      reason: 'the ticket was not used by this user',
    });
    // Nor does the invite record, which is all a server holds, do it without the secret.
    const guessed = joinWith(dave, inv, newTicket());
    expect(validateRecord(guessed, ctx([space(), inv], false))).toMatchObject({ ok: false });
  });

  it('is not joined by naming it as an invite code, however the record is taken', () => {
    const inv = invite();
    const named = signRecord(dave, 'member', recordKey.member(spaceId, dave.userId), {
      spaceId,
      userId: dave.userId,
      inviteCode: ticket.tid,
    });
    for (const fresh of [true, false])
      expect(validateRecord(named, ctx([space(), inv], fresh))).toMatchObject({
        ok: false,
        reason: 'this invite is used with its ticket',
      });
    // And one is not both.
    const both = joinWith(carol, inv, ticket, { inviteCode: ticket.tid });
    expect(validateRecord(both, ctx([space(), inv]))).toMatchObject({ ok: false });
  });

  it('is made by the owner, an admin, or a former one, and no one else', () => {
    const asAdmin = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [bob.userId],
        publicInvite: ticket.tid,
        authority: signSpaceAuthority(alice, spaceId, [bob.userId], now - 2000),
      },
      now - 2000,
    );
    const byBob = invite(bob);
    expect(validateRecord(byBob, ctx([asAdmin])).ok).toBe(true);
    expect(validateRecord(joinWith(carol, byBob), ctx([asAdmin, byBob])).ok).toBe(true);
    // Not by someone the space does not know. (Such an invite is not even taken.)
    const byMallory = invite(mallory);
    expect(validateRecord(byMallory, ctx([space()]))).toMatchObject({ ok: false });
    expect(validateRecord(joinWith(carol, byMallory), ctx([space()], false))).toMatchObject({
      ok: false,
      reason: 'invite was made by someone who could not invite',
      // (The space we hold may be older than the one that lists them: try again later.)
      retryable: true,
    });
    // A write straight from its author is not held to be tried again.
    const written = validateRecord(joinWith(carol, byMallory), ctx([space()]));
    expect(written).toMatchObject({ ok: false });
    expect(written).not.toMatchObject({ retryable: true });
  });

  it('keeps those an admin let in when the owner removes the admin, if the owner lists them as former', () => {
    const admins = [bob.userId];
    const asAdmin = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins,
        publicInvite: ticket.tid,
        authority: signSpaceAuthority(alice, spaceId, admins, now - 2000),
      },
      now - 2000,
    );
    const byBob = invite(bob);
    const join = joinWith(carol, byBob);
    expect(isSpaceMember(ctx([asAdmin, join]), spaceId, carol.userId)).toBe(true);
    // Removed without being listed: what they made no longer admits anyone.
    const removed = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [],
        publicInvite: ticket.tid,
        authority: signSpaceAuthority(alice, spaceId, [], now - 1500),
      },
      now - 1500,
    );
    expect(isSpaceMember(ctx([removed, join]), spaceId, carol.userId)).toBe(false);
    expect(validateRecord(join, ctx([removed], false))).toMatchObject({ ok: false });
    // Listed as former: they stay, on the path that has no clock...
    const listed = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [],
        formerAdmins: [bob.userId],
        publicInvite: ticket.tid,
        authority: signSpaceAuthority(alice, spaceId, [], now - 1500, undefined, [bob.userId]),
      },
      now - 1500,
    );
    expect(validateRecord(listed, ctx([asAdmin])).ok).toBe(true);
    expect(isSpaceMember(ctx([listed, join]), spaceId, carol.userId)).toBe(true);
    expect(validateRecord(join, ctx([listed], false)).ok).toBe(true);
    // ...but nobody new joins by it where a join is taken as it is made.
    expect(validateRecord(join, ctx([listed, byBob]))).toMatchObject({
      ok: false,
      reason: 'invite was made by someone who may no longer invite',
    });
  });

  it('can only be added to in the list of former admins, and only by the owner', () => {
    const listed = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [],
        formerAdmins: [bob.userId],
        authority: signSpaceAuthority(alice, spaceId, [], now - 1500, undefined, [bob.userId]),
      },
      now - 1500,
    );
    const dropped = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins: [],
        authority: signSpaceAuthority(alice, spaceId, [], now - 1400),
      },
      now - 1400,
    );
    expect(validateRecord(dropped, ctx([listed]))).toMatchObject({
      ok: false,
      reason: 'former admins cannot be taken off the list',
    });
    // An admin cannot list anyone: the owner's signature is over the list.
    const admins = [carol.userId];
    const asAdmin = signRecord(
      alice,
      'space',
      key,
      {
        ...base,
        admins,
        authority: signSpaceAuthority(alice, spaceId, admins, now - 2000),
      },
      now - 2000,
    );
    const added = signRecord(
      carol,
      'space',
      key,
      { ...asAdmin.body, formerAdmins: [mallory.userId] },
      now - 1900,
    );
    expect(validateRecord(added, ctx([asAdmin]))).toMatchObject({
      ok: false,
      reason: 'bad admin list signature',
    });
  });

  it('still verifies an admin list signed before there were former admins', () => {
    // What the code signed before: nothing about former admins in it, an empty list the same.
    const signed = sign(alice, SIG_DOMAIN.spaceAdmins, { spaceId, admins: [bob.userId], at: 1234 });
    const body = {
      ...base,
      admins: [bob.userId],
      authority: { ownerKey: alice.publicKey, at: 1234, sig: signed },
    };
    expect(spaceAuthorityValid(spaceId, body)).toBe(true);
    expect(spaceAuthorityValid(spaceId, { ...body, formerAdmins: [] })).toBe(true);
    expect(spaceAuthorityValid(spaceId, { ...body, formerAdmins: [mallory.userId] })).toBe(false);
  });

  it('is judged, where a join is taken as it is made, by whether the link is on', () => {
    const inv = invite();
    const join = joinWith(carol, inv);
    const revoked = signRecord(alice, 'invite', recordKey.invite(ticket.tid), {
      ...inv.body,
      revoked: true,
    });
    expect(validateRecord(join, ctx([space(), revoked]))).toMatchObject({
      ok: false,
      reason: 'invite was revoked',
    });
    const replaced = space({ publicInvite: newTicket().tid });
    expect(validateRecord(join, ctx([replaced, inv]))).toMatchObject({
      ok: false,
      reason: 'this link has been replaced or turned off',
    });
    const expired = invite(alice, { expiresAt: now - 1000 });
    expect(validateRecord(joinWith(carol, expired), ctx([space(), expired]))).toMatchObject({
      ok: false,
      reason: 'invite expired',
    });
    expect(validateRecord(join, ctx([space({ bans: [carol.userId] }), inv]))).toMatchObject({
      ok: false,
      reason: 'you are banned from this space',
    });
    expect(validateRecord(join, ctx([space()]))).toMatchObject({ ok: false, retryable: true });
    // The invite held for the name is that of this space.
    const elsewhere = signRecord(alice, 'invite', recordKey.invite(ticket.tid), {
      ...inv.body,
      spaceId: spaceIdFor(alice.publicKey, randomId()),
    });
    expect(validateRecord(join, ctx([space(), elsewhere]))).toMatchObject({
      ok: false,
      reason: 'ticket does not match its invite',
    });
    // A membership already made is still one when the link is turned off.
    expect(validateRecord(join, ctx([replaced, revoked], false)).ok).toBe(true);
    // Another invite's record does not stand in for the one the member carries.
    const other = newTicket();
    const mine = invite(alice, {}, other);
    const carried = joinWith(carol, mine, other);
    expect(validateRecord(carried, ctx([space({ publicInvite: other.tid }), inv]))).toMatchObject({
      ok: false,
      reason: 'unknown invite',
    });
  });

  it('is made only as the open link: named by the hash of its key, and not for a person', () => {
    expect(validateRecord(invite(), ctx([space()])).ok).toBe(true);
    const wrongName = newTicket();
    const misnamed = signRecord(alice, 'invite', recordKey.invite(wrongName.tid), {
      spaceId,
      code: wrongName.tid,
      tpub: ticket.tpub,
      expiresAt: now + week,
    });
    expect(validateRecord(misnamed, ctx([space()]))).toMatchObject({
      ok: false,
      reason: 'invite name does not match its key',
    });
    const named = invite(alice, { for: carol.userId });
    expect(validateRecord(named, ctx([space()]))).toMatchObject({
      ok: false,
      reason: 'a ticket is for the open link',
    });
    // The key of a link does not change under it.
    const first = invite();
    const swapped = signRecord(
      alice,
      'invite',
      recordKey.invite(ticket.tid),
      { spaceId, code: ticket.tid, expiresAt: now + week },
      Date.now() + 1000,
    );
    expect(validateRecord(swapped, ctx([space(), first]))).toMatchObject({
      ok: false,
      reason: 'an invite cannot change its ticket',
    });
  });
});

describe('hybrid post-quantum sealed boxes', () => {
  it('only the target device can open, sender is authenticated', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const bobPeer = `${bob.userId}.bobdevice1`;
    const pk = createPrekey();
    const box = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('hello bob'),
    );
    const lookup = (id: number) => (id === pk.id ? pk : undefined);
    const opened = openSealed({ peer: bobPeer }, lookup, box, userIdFromKey);
    expect(opened?.from).toBe(`${alice.userId}.alicedev1`);
    expect(utf8.decode(opened!.plaintext)).toBe('hello bob');
    // Wrong device, wrong prekey, forged sender, tampering: all rejected.
    expect(openSealed({ peer: `${bob.userId}.otherdev11` }, lookup, box, userIdFromKey)).toBeNull();
    expect(openSealed({ peer: bobPeer }, () => createPrekey(), box, userIdFromKey)).toBeNull();
    expect(
      openSealed({ peer: bobPeer }, lookup, { ...box, from: eve.publicKey }, userIdFromKey),
    ).toBeNull();
    expect(
      openSealed(
        { peer: bobPeer },
        lookup,
        { ...box, ct: box.ct.slice(0, -2) + 'AA' },
        userIdFromKey,
      ),
    ).toBeNull();
    // Length hiding: boxes are padded.
    const small = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('x'),
    );
    const medium = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('x'.repeat(40)),
    );
    expect(small.ct.length).toBe(medium.ct.length);
  });

  it("a box carried to its recipient cannot be signed over as someone else's", () => {
    const alice = createIdentity();
    const mallory = createIdentity();
    const bob = createIdentity();
    const bobPeer = `${bob.userId}.bobdevice1`;
    const pk = createPrekey();
    const lookup = (id: number) => (id === pk.id ? pk : undefined);
    const box = sealToDevice(
      alice,
      'alicedev1',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode("alice's sender key"),
    );
    // Whoever carries the box swaps in their own name and signs it themselves.
    const unsigned = { ...box, from: mallory.publicKey, fromDevice: 'malloryd1' };
    const { sig: _, ...rest } = unsigned;
    const resigned = {
      ...unsigned,
      sig: sign(mallory, SIG_DOMAIN.sealed, { ...rest, rx: pk.bundle.x25519 }),
    };
    expect(
      verifyPayload(
        mallory.publicKey,
        SIG_DOMAIN.sealed,
        { ...rest, rx: pk.bundle.x25519 },
        resigned.sig,
      ),
    ).toBe(true);
    expect(openSealed({ peer: bobPeer }, lookup, resigned, userIdFromKey)).toBeNull();
    // The one it was sealed by still opens it.
    expect(openSealed({ peer: bobPeer }, lookup, box, userIdFromKey)?.from).toBe(
      `${alice.userId}.alicedev1`,
    );
  });

  it('rotates prekeys and forgets expired secrets', () => {
    const t0 = 1_000_000_000_000;
    const first = rotatePrekeys([], t0);
    expect(first.keys).toHaveLength(1);
    expect(rotatePrekeys(first.keys, t0 + 1000).rotated).toBe(false);
    const later = rotatePrekeys(first.keys, t0 + PREKEY_LIFETIME_MS - 1000);
    expect(later.keys).toHaveLength(2);
    const much = rotatePrekeys(later.keys, t0 + PREKEY_LIFETIME_MS + 3 * 24 * 3600_000);
    expect(much.keys.map((k) => k.id)).not.toContain(first.keys[0]!.id);
  });

  it("keeps an offline device's prekey until the grace period after it comes back", () => {
    const t0 = 1_000_000_000_000;
    const first = rotatePrekeys([], t0);
    const id = first.keys[0]!.id;
    // Offline for 30 days: on return the old key is replaced but kept for mail.
    const back = rotatePrekeys(first.keys, t0 + 30 * 24 * 3600_000);
    expect(back.rotated).toBe(true);
    expect(back.keys.map((k) => k.id)).toContain(id);
    const soon = rotatePrekeys(back.keys, t0 + 31 * 24 * 3600_000);
    expect(soon.keys.map((k) => k.id)).toContain(id);
    const after = rotatePrekeys(back.keys, t0 + 33 * 24 * 3600_000);
    expect(after.keys.map((k) => k.id)).not.toContain(id);
  });

  it('links devices: only the new device opens, and the security codes agree', () => {
    const account = createIdentity();
    const temp = createIdentity();
    const kem = createLinkKem();
    const to = { encKey: temp.encPublicKey, kemKey: kem.publicKey };
    const box = sealLink(account, to, account.seed);
    expect(openLink(temp, kem, box, account.userId)).toEqual(account.seed);
    expect(openLink(temp, kem, box, createIdentity().userId)).toBeNull();
    expect(openLink(createIdentity(), kem, box, account.userId)).toBeNull();
    expect(openLink(temp, createLinkKem(), box, account.userId)).toBeNull();
    const nNew = linkNonce();
    const nOld = linkNonce();
    const [k, e, m] = [temp.publicKey, temp.encPublicKey, kem.publicKey];
    const commit = linkCommitment(k, e, m, nNew);
    expect(linkCommitmentValid(k, e, m, nNew, commit)).toBe(true);
    const shown = linkSecurityCode(k, e, m, account.publicKey, nNew, nOld);
    expect(shown).toMatch(/^\d{3} \d{3}$/);
    // A different X25519 or ML-KEM key, or the nonces swapped, gives a different code.
    const other = createIdentity().encPublicKey;
    const otherKem = createLinkKem().publicKey;
    expect(linkSecurityCode(k, other, m, account.publicKey, nNew, nOld)).not.toBe(shown);
    expect(linkSecurityCode(k, e, otherKem, account.publicKey, nNew, nOld)).not.toBe(shown);
    expect(linkSecurityCode(k, e, m, account.publicKey, nOld, nNew)).not.toBe(shown);
    // The commit holds the new device to its keys and its nonce.
    expect(linkCommitmentValid(k, other, m, nNew, commit)).toBe(false);
    expect(linkCommitmentValid(k, e, otherKem, nNew, commit)).toBe(false);
    expect(linkCommitmentValid(k, e, m, linkNonce(), commit)).toBe(false);
    expect(linkCommitmentValid(k, e, m, 'short', commit)).toBe(false);
  });
});

describe('ratcheting sender keys', () => {
  it('text: per-message ratchet, out-of-order within a window, no going back', () => {
    const sk = createSenderKey();
    const exported = exportChains(sk);
    const rx = new TextReceiver(sk.kid, importChain(exported.text));
    const m0 = encryptText(sk, utf8.encode('zero'));
    const m1 = encryptText(sk, utf8.encode('one'));
    const m2 = encryptText(sk, utf8.encode('two'));
    expect(utf8.decode(rx.decrypt(m2.g, m2.ct)!)).toBe('two');
    expect(utf8.decode(rx.decrypt(m0.g, m0.ct)!)).toBe('zero');
    expect(rx.decrypt(m0.g, m0.ct)).toBeNull(); // replay
    expect(utf8.decode(rx.decrypt(m1.g, m1.ct)!)).toBe('one');
    // A member given the current chain cannot read earlier messages.
    const late = new TextReceiver(sk.kid, importChain(exportChains(sk).text));
    expect(late.decrypt(m1.g, m1.ct)).toBeNull();
    const m3 = encryptText(sk, utf8.encode('three'));
    expect(utf8.decode(late.decrypt(m3.g, m3.ct)!)).toBe('three');
    // Bogus far-future generations do not advance state.
    expect(rx.decrypt(m3.g + 5000, m3.ct)).toBeNull();
    expect(utf8.decode(rx.decrypt(m3.g, m3.ct)!)).toBe('three');
  });

  it('audio: frames across generations, tampering rejected', () => {
    const sk = createSenderKey();
    const sender = new AudioSender(sk.kid, sk.audio);
    const rx = new AudioReceiver(sk.kid, importChain(exportChains(sk).audio));
    const frame = Uint8Array.from({ length: 80 }, (_, i) => i);
    const f0 = sender.encrypt(frame);
    expect(peekFrameKid(f0)).toBe(sk.kid);
    expect(rx.decrypt(f0)).toEqual(frame);
    sender.update(ratchet(ratchet(sk.audio)));
    const f2 = sender.encrypt(frame);
    expect(rx.decrypt(f2)).toEqual(frame);
    expect(rx.gen).toBe(2);
    const bad = f2.slice();
    bad[3] = bad[3]! ^ 1;
    expect(rx.decrypt(bad)).toBeNull();
    const other = createSenderKey();
    expect(new AudioReceiver(other.kid, other.audio).decrypt(f2)).toBeNull();
  });

  it('audio: a sender rebuilt from the same key does not reuse its nonces', () => {
    const sk = createSenderKey();
    const counterOf = (f: Uint8Array) =>
      new DataView(f.buffer, f.byteOffset + f.length - 11, 11).getUint32(6);
    // Two senders from one key state, as after a reconnect: their frame
    // counters (and so their nonces) start apart.
    const first = Array.from({ length: 5 }, () =>
      counterOf(new AudioSender(sk.kid, sk.audio).encrypt(new Uint8Array(40))),
    );
    expect(new Set(first).size).toBe(5);
    const rx = new AudioReceiver(sk.kid, importChain(exportChains(sk).audio));
    expect(rx.decrypt(new AudioSender(sk.kid, sk.audio).encrypt(new Uint8Array(40)))).toEqual(
      new Uint8Array(40),
    );
  });

  it('video: the codec header stays readable, everything is authenticated', () => {
    const sk = createSenderKey();
    const sender = new VideoSender(sk.kid, sk.audio);
    const rx = new VideoReceiver(sk.kid, importChain(exportChains(sk).audio));
    const frame = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff);
    const key = sender.encrypt(frame, 10);
    expect(peekFrameKid(key)).toBe(sk.kid);
    // The first 10 bytes (a VP8 key frame's header) are as they were; the rest isn't.
    expect(key.subarray(0, 10)).toEqual(frame.subarray(0, 10));
    expect(key.subarray(10, 40)).not.toEqual(frame.subarray(10, 40));
    expect(rx.decrypt(key)).toEqual(frame);
    const delta = sender.encrypt(frame, 3);
    expect(rx.decrypt(delta)).toEqual(frame);
    // A changed clear byte, body byte or clear length is refused.
    for (const at of [0, 20, key.length - 2]) {
      const bad = key.slice();
      bad[at] = bad[at]! ^ 1;
      expect(rx.decrypt(bad)).toBeNull();
    }
    // Never more in the clear than allowed, however much is asked for.
    const capped = sender.encrypt(frame, 5000);
    expect(capped[capped.length - 2]).toBe(VIDEO_MAX_CLEAR);
    expect(rx.decrypt(capped)).toEqual(frame);
    // Across generations, like audio.
    sender.update(ratchet(sk.audio));
    expect(rx.decrypt(sender.encrypt(frame, 3))).toEqual(frame);
  });

  describe.each([
    {
      name: 'audio',
      make: (sk: ReturnType<typeof createSenderKey>) => {
        const sender = new AudioSender(sk.kid, sk.audio);
        return {
          encrypt: (f: Uint8Array) => sender.encrypt(f),
          update: (c: typeof sk.audio) => sender.update(c),
          setCounter: (n: number) => ((sender as unknown as { counter: number }).counter = n),
          receiver: () => new AudioReceiver(sk.kid, importChain(exportChains(sk).audio)),
        };
      },
    },
    {
      name: 'video',
      make: (sk: ReturnType<typeof createSenderKey>) => {
        const sender = new VideoSender(sk.kid, sk.audio);
        return {
          encrypt: (f: Uint8Array) => sender.encrypt(f, 3),
          update: (c: typeof sk.audio) => sender.update(c),
          setCounter: (n: number) => ((sender as unknown as { counter: number }).counter = n),
          receiver: () => new VideoReceiver(sk.kid, importChain(exportChains(sk).audio)),
        };
      },
    },
  ])('$name frames are taken once', ({ make }) => {
    const frame = Uint8Array.from({ length: 80 }, (_, i) => i);

    it('refuses a frame played again, and takes frames out of order', () => {
      const sk = createSenderKey();
      const tx = make(sk);
      const rx = tx.receiver();
      const frames = Array.from({ length: 10 }, () => tx.encrypt(frame));
      for (const i of [3, 0, 2, 9, 1, 8, 4, 7, 5, 6]) expect(rx.decrypt(frames[i]!)).toEqual(frame);
      for (const f of frames) expect(rx.decrypt(f)).toBeNull();
    });

    it('refuses frames older than the window, and takes those just inside it', () => {
      const sk = createSenderKey();
      const tx = make(sk);
      const rx = tx.receiver();
      const frames = Array.from({ length: 1100 }, () => tx.encrypt(frame));
      expect(rx.decrypt(frames[1099]!)).toEqual(frame);
      expect(rx.decrypt(frames[0]!)).toBeNull();
      expect(rx.decrypt(frames[100]!)).toEqual(frame);
      expect(rx.decrypt(frames[100]!)).toBeNull();
      // Right at the edge: 1023 back is still in the window, 1024 back is not.
      expect(rx.decrypt(frames[1099 - 1023]!)).toEqual(frame);
      expect(rx.decrypt(frames[1099 - 1024]!)).toBeNull();
    });

    it('keeps count when the frame counter wraps around', () => {
      const sk = createSenderKey();
      const tx = make(sk);
      tx.setCounter(0xfffffffa);
      const rx = tx.receiver();
      const frames = Array.from({ length: 12 }, () => tx.encrypt(frame));
      for (const i of [0, 1, 9, 11, 5, 10, 2, 3, 4, 6, 7, 8])
        expect(rx.decrypt(frames[i]!)).toEqual(frame);
      for (const f of frames) expect(rx.decrypt(f)).toBeNull();
    });

    it('refuses a frame of the previous generation played again after the next began', () => {
      const sk = createSenderKey();
      const tx = make(sk);
      const rx = tx.receiver();
      const old = tx.encrypt(frame);
      expect(rx.decrypt(old)).toEqual(frame);
      tx.update(ratchet(sk.audio));
      expect(rx.decrypt(tx.encrypt(frame))).toEqual(frame);
      expect(rx.decrypt(old)).toBeNull();
    });
  });

  it('a receiver told of a later chain position follows it, keeps what it took just before, and ignores an earlier one', () => {
    const sk = createSenderKey();
    const sender = new AudioSender(sk.kid, sk.audio);
    const rx = new AudioReceiver(sk.kid, importChain(exportChains(sk).audio));
    const frame = new Uint8Array(50).fill(1);
    const old = sender.encrypt(frame);
    expect(rx.decrypt(old)).toEqual(frame);
    // One generation on: the frames of the last one that were taken stay taken.
    const next = ratchet(sk.audio);
    rx.catchUp(next);
    expect(rx.gen).toBe(next.gen);
    expect(rx.decrypt(old)).toBeNull();
    sender.update(next);
    expect(rx.decrypt(sender.encrypt(frame))).toEqual(frame);
    // Far ahead (a sender quiet for long): follows, so what comes next can be followed.
    let far = next;
    for (let i = 0; i < 40; i++) far = ratchet(far);
    sender.update(far);
    const spoken = sender.encrypt(frame);
    expect(rx.decrypt(spoken)).toBeNull();
    rx.catchUp(far);
    expect(rx.decrypt(spoken)).toEqual(frame);
    // An earlier position changes nothing.
    rx.catchUp(sk.audio);
    expect(rx.gen).toBe(far.gen);
  });

  it('counters half the range apart are neither ahead nor behind: refused, and nothing is marked', () => {
    const sk = createSenderKey();
    const tx = new AudioSender(sk.kid, sk.audio);
    const rx = new AudioReceiver(sk.kid, importChain(exportChains(sk).audio));
    const frame = new Uint8Array(50).fill(1);
    const first = tx.encrypt(frame);
    const counterOf = (f: Uint8Array) =>
      new DataView(f.buffer, f.byteOffset + f.length - 11, 11).getUint32(6);
    const c0 = counterOf(first);
    expect(rx.decrypt(first)).toEqual(frame);
    (tx as unknown as { counter: number }).counter = (c0 + 0x80000000) >>> 0;
    const far = tx.encrypt(frame);
    expect(rx.decrypt(far)).toBeNull();
    // The window is as it was: the next frame in order is taken.
    (tx as unknown as { counter: number }).counter = c0 + 1;
    expect(rx.decrypt(tx.encrypt(frame))).toEqual(frame);
  });

  it("video and audio frames can't stand in for each other", () => {
    const sk = createSenderKey();
    const frame = new Uint8Array(200).fill(9);
    const audio = new AudioSender(sk.kid, sk.audio).encrypt(frame);
    const video = new VideoSender(sk.kid, sk.audio).encrypt(frame, 0);
    const chain = () => importChain(exportChains(sk).audio);
    expect(new VideoReceiver(sk.kid, chain()).decrypt(audio)).toBeNull();
    expect(new AudioReceiver(sk.kid, chain()).decrypt(video)).toBeNull();
    // Same layout but the audio magic byte: still another key, so refused.
    const relabelled = video.slice(0, video.length - 2);
    const asAudio = new Uint8Array(relabelled.length + 1);
    asAudio.set(relabelled);
    asAudio[asAudio.length - 1] = 0xc8;
    expect(new AudioReceiver(sk.kid, chain()).decrypt(asAudio)).toBeNull();
  });
});

describe('secure channel', () => {
  it('hybrid handshake, encrypted frames, replay protection', () => {
    const keys = createChannelKeys();
    const { answer, secret } = answerChannel(keys.offer);
    const server = new SecureChannel(acceptChannel(keys, answer), 'ctx', false);
    const client = new SecureChannel(secret, 'ctx', true);
    const f1 = client.seal({ hello: 'world' });
    expect(server.open(f1)).toEqual({ hello: 'world' });
    expect(server.open(f1)).toBeUndefined();
    const back = server.seal({ ok: true });
    expect(client.open(back)).toEqual({ ok: true });
    expect(new SecureChannel(secret, 'other', false).open(client.seal({ x: 1 }))).toBeUndefined();
  });

  it('padme buckets', () => {
    expect(padmeLength(10)).toBe(64);
    expect(padmeLength(1000)).toBeGreaterThanOrEqual(1000);
    expect(padmeLength(1000)).toBeLessThan(1000 * 1.13);
  });
});

describe('messages and signalling', () => {
  it('verifies signed chat messages', () => {
    const alice = createIdentity();
    const msg = createChatMessage(alice, { ch: 'general', body: 'hi' });
    expect(verifyChatMessage(msg)).toBe(true);
    expect(verifyChatMessage({ ...msg, body: 'bye' })).toBe(false);
    expect(verifyChatMessage({ ...msg, author: createIdentity().userId })).toBe(false);
  });

  it('signs the session a message was written for', () => {
    const alice = createIdentity();
    const msg = createChatMessage(alice, { ch: 'general', sid: 'space:one', body: 'hi' });
    expect(msg.sid).toBe('space:one');
    expect(verifyChatMessage(msg)).toBe(true);
    expect(verifyChatMessage({ ...msg, sid: 'space:two' })).toBe(false);
    const { sid: _, ...without } = msg;
    expect(verifyChatMessage(without)).toBe(false);
  });

  it('derives a file id from the author and the key, and from nothing else', () => {
    const key = newFileKey();
    const id = fileIdFor('aaaaaaaaaaaaaaaaaaaaaaaaaa', key);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fileIdFor('aaaaaaaaaaaaaaaaaaaaaaaaaa', key)).toBe(id);
    expect(fileIdFor('bbbbbbbbbbbbbbbbbbbbbbbbbb', key)).not.toBe(id);
    expect(fileIdFor('aaaaaaaaaaaaaaaaaaaaaaaaaa', newFileKey())).not.toBe(id);
  });

  it('only lets an author post a file under the id their own key gives it', () => {
    const alice = createIdentity();
    const mallory = createIdentity();
    const manifest = (author: typeof alice, key = newFileKey()) => ({
      id: fileIdFor(author.userId, key),
      name: 'a.pdf',
      size: 10,
      type: 'application/pdf',
      key,
      root: newFileKey(),
    });
    const real = createChatMessage(alice, { ch: 'general', body: '', file: manifest(alice) });
    expect(verifyChatMessage(real)).toBe(true);
    // Mallory signs a message of her own that carries Alice's file id.
    const squat = createChatMessage(mallory, {
      ch: 'general',
      body: '',
      file: { ...manifest(mallory), id: real.file!.id },
    });
    expect(verifyChatMessage(squat)).toBe(false);
    // Nor can she post Alice's whole manifest as hers.
    expect(
      verifyChatMessage(createChatMessage(mallory, { ch: 'general', body: '', file: real.file })),
    ).toBe(false);
  });

  it('binds SDP to session and peers', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const from = `${alice.userId}.aaaadevice`;
    const to = `${bob.userId}.bbbbdevice`;
    const offer = signSdp(alice, 'offer', { sessionId: 's', epoch: 1, from, to }, 'v=0...');
    expect(verifySdp(offer, { sessionId: 's', from, to })).toBe(true);
    expect(verifySdp(offer, { sessionId: 'other', from, to })).toBe(false);
    expect(verifySdp(offer, { sessionId: 's', from: `${bob.userId}.aaaadevice`, to })).toBe(false);
    expect(verifySdp({ ...offer, sdp: 'v=0 evil' }, { sessionId: 's', from, to })).toBe(false);
  });
});

describe('anonymous boxes', () => {
  it('hide the sender from everyone but the target device, which can verify them', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const bobPeer = `${bob.userId}.bobdevicea`;
    const pk = createPrekey();
    const lookup = (id: number) => (id === pk.id ? pk : undefined);
    const box = sealAnonymous(
      alice,
      'alicedeva',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('psst'),
    );
    expect(AnonBox.safeParse(box).success).toBe(true);
    // Nothing outside the encryption says who sent it.
    const outside = JSON.stringify(box);
    expect(outside).not.toContain(alice.publicKey);
    expect(outside).not.toContain(alice.userId);
    expect(outside).not.toContain('alicedeva');

    const opened = openAnonymous({ peer: bobPeer }, lookup, box, userIdFromKey);
    expect(opened?.from).toBe(`${alice.userId}.alicedeva`);
    expect(opened?.fromKey).toBe(alice.publicKey);
    expect(utf8.decode(opened!.plaintext)).toBe('psst');

    // Another device, another prekey, tampering: all rejected.
    expect(
      openAnonymous({ peer: `${bob.userId}.otherdevaa` }, lookup, box, userIdFromKey),
    ).toBeNull();
    expect(openAnonymous({ peer: bobPeer }, () => createPrekey(), box, userIdFromKey)).toBeNull();
    const flipped = box.ct.slice(0, 10) + (box.ct[10] === 'A' ? 'B' : 'A') + box.ct.slice(11);
    expect(
      openAnonymous({ peer: bobPeer }, lookup, { ...box, ct: flipped }, userIdFromKey),
    ).toBeNull();
    // Bob can't pass it on to Carol as if Alice had written to her: the
    // signature covers the device it was sealed to.
    const carolPeer = `${eve.userId}.caroldev`;
    const readdressed = { ...box, to: carolPeer };
    expect(openAnonymous({ peer: carolPeer }, lookup, readdressed, userIdFromKey)).toBeNull();
    // Padded: short payloads look alike.
    const longer = sealAnonymous(
      alice,
      'alicedeva',
      { peer: bobPeer, prekey: pk.bundle },
      utf8.encode('psst, psst'),
    );
    expect(longer.ct.length).toBe(box.ct.length);
  });
});

describe('sealed for self', () => {
  it("opens only with the same account's key and for the same place", () => {
    const alice = createIdentity();
    const sealed = sealForSelf(alice, 'friends', utf8.encode('my list'), 'friends:x');
    expect(utf8.decode(openForSelf(alice, 'friends', sealed, 'friends:x')!)).toBe('my list');
    // Same account on another device: same seed, same key.
    const laptop = identityFromSeed(alice.seed);
    expect(utf8.decode(openForSelf(laptop, 'friends', sealed, 'friends:x')!)).toBe('my list');
    expect(openForSelf(createIdentity(), 'friends', sealed, 'friends:x')).toBeNull();
    expect(openForSelf(alice, 'other', sealed, 'friends:x')).toBeNull();
    expect(openForSelf(alice, 'friends', sealed, 'friends:y')).toBeNull();
    expect(openForSelf(alice, 'friends', 'not base64!', 'friends:x')).toBeNull();
    // Fresh nonce every time.
    expect(sealForSelf(alice, 'friends', utf8.encode('my list'), 'friends:x')).not.toBe(sealed);
  });
});

describe('notes', () => {
  const bob = createIdentity();
  const once = () => createIdentity();
  const boxForBob = () =>
    sealAnonymous(
      once(),
      'somedevice',
      { peer: `${bob.userId}.somedevice`, prekey: createPrekey().bundle },
      utf8.encode('x'),
    );
  const note = (author = once(), version = Date.now()) =>
    signRecord(
      author,
      'note',
      recordKey.note(bob.userId, author.userId),
      { boxes: [boxForBob()] },
      version,
    );

  it('are signed by a one-time key named in the key, and written once', () => {
    const n = note();
    expect(validateRecord(n, ctx([])).ok).toBe(true);
    const author = once();
    const misnamed = signRecord(author, 'note', recordKey.note(bob.userId, once().userId), {
      boxes: [],
    });
    expect(validateRecord(misnamed, ctx([]))).toMatchObject({ ok: false });
    const first = note(author, Date.now() - 1000);
    const again = signRecord(author, 'note', first.key, { boxes: [] });
    expect(validateRecord(again, ctx([first]))).toMatchObject({
      ok: false,
      reason: 'note already exists',
    });
    // Boxes for someone else's devices don't belong in Bob's notes.
    const pk = createPrekey();
    const stray = signRecord(author, 'note', recordKey.note(bob.userId, author.userId), {
      boxes: [
        sealAnonymous(
          once(),
          'somedevice',
          { peer: `${once().userId}.somedevice`, prekey: pk.bundle },
          utf8.encode('x'),
        ),
      ],
    });
    expect(validateRecord(stray, ctx([]))).toMatchObject({ ok: false });
    // An empty one would only take a place in Bob's quota.
    const empty = once();
    expect(
      validateRecord(
        signRecord(empty, 'note', recordKey.note(bob.userId, empty.userId), { boxes: [] }),
        ctx([]),
      ),
    ).toMatchObject({ ok: false, reason: 'a note carries at least one box' });
  });

  it('only the recipient deletes them, and nothing brings back an expired one', () => {
    const n = note();
    const del = (by: typeof bob) =>
      signRecord(by, 'note', n.key, { boxes: [], deleted: true }, n.version + 1);
    expect(validateRecord(del(bob), ctx([n])).ok).toBe(true);
    expect(validateRecord(del(once()), ctx([n]))).toMatchObject({ ok: false });
    const old = note(once(), Date.now() - NOTE_TTL_MS - 1000);
    expect(validateRecord(old, ctx([], false))).toMatchObject({
      ok: false,
      reason: 'note expired',
    });
  });
});

describe('session operations', () => {
  const alice = createIdentity();
  const mallory = createIdentity();
  const sessionId = 'voice:abcdefgh:ijklmnop';
  const peer = `${alice.userId}.abcdefghij`;
  const caps: HostCaps = { canHost: true, platform: 'desktop', nat: 'open', uplinkKbps: 5000 };
  const join = { op: 'join', caps } as const;
  const report3 = { op: 'report', epoch: 3, issue: 'host_unreachable' } as const;
  const context = { server: 'server-one', at: 1_700_000_000_000 };

  it('accepts what the device signed, for the account of its peer id', () => {
    const proof = signSessionOp(alice, sessionId, peer, join, context);
    expect(verifySessionOp(alice.publicKey, sessionId, peer, join, proof)).toBe(true);
    const update = signSessionOp(
      alice,
      sessionId,
      peer,
      { op: 'update', caps },
      { ...context, since: 5, n: 1 },
    );
    expect(verifySessionOp(alice.publicKey, sessionId, peer, { op: 'update', caps }, update)).toBe(
      true,
    );
    const report = signSessionOp(alice, sessionId, peer, report3, { ...context, since: 5 });
    expect(verifySessionOp(alice.publicKey, sessionId, peer, report3, report)).toBe(true);
  });

  it('is for the account whose id the peer carries, whoever holds a key', () => {
    // Another account signing for Alice's device.
    const forged = signSessionOp(mallory, sessionId, peer, join, context);
    expect(verifySessionOp(mallory.publicKey, sessionId, peer, join, forged)).toBe(false);
    expect(verifySessionOp(alice.publicKey, sessionId, peer, join, forged)).toBe(false);
    // Alice's key does not vouch for another account's device.
    const other = `${mallory.userId}.abcdefghij`;
    const mine = signSessionOp(alice, sessionId, other, join, context);
    expect(verifySessionOp(alice.publicKey, sessionId, other, join, mine)).toBe(false);
  });

  it('covers where, who, for which server, when and what was asked', () => {
    const proof = signSessionOp(
      alice,
      sessionId,
      peer,
      { op: 'update', caps },
      { ...context, since: 5, n: 1 },
    );
    const update = { op: 'update', caps } as const;
    const check = (
      id: string,
      who: string,
      op: typeof update | { op: 'join'; caps: HostCaps },
      p: SessionOpProof,
    ) => verifySessionOp(alice.publicKey, id, who, op, p);
    expect(check(sessionId, peer, update, proof)).toBe(true);
    // Another room, another of Alice's devices, another operation.
    expect(check('voice:abcdefgh:qrstuvwx', peer, update, proof)).toBe(false);
    expect(check(sessionId, `${alice.userId}.zzzzzzzzzz`, update, proof)).toBe(false);
    expect(check(sessionId, peer, { op: 'join', caps }, proof)).toBe(false);
    // Another server (the point: a server cannot use what was signed for another), time, join or count.
    expect(check(sessionId, peer, update, { ...proof, server: 'server-two' })).toBe(false);
    expect(check(sessionId, peer, update, { ...proof, at: proof.at + 1 })).toBe(false);
    expect(check(sessionId, peer, update, { ...proof, since: 6 })).toBe(false);
    expect(check(sessionId, peer, update, { ...proof, n: 2 })).toBe(false);
    expect(check(sessionId, peer, update, { ...proof, n: undefined })).toBe(false);
    // What it says about the device.
    expect(
      check(sessionId, peer, { op: 'update', caps: { ...caps, uplinkKbps: 9000 } }, proof),
    ).toBe(false);
    expect(check(sessionId, peer, { op: 'update', caps: { ...caps, nat: 'cone' } }, proof)).toBe(
      false,
    );
  });

  it('keeps a report to its epoch', () => {
    const proof = signSessionOp(alice, sessionId, peer, report3, { ...context, since: 5 });
    expect(verifySessionOp(alice.publicKey, sessionId, peer, { ...report3, epoch: 4 }, proof)).toBe(
      false,
    );
    expect(
      verifySessionOp(alice.publicKey, sessionId, peer, report3, { ...proof, since: undefined }),
    ).toBe(false);
  });

  it('does not take what was signed for something else', () => {
    // The mailbox signs a similar payload in another domain.
    const proof = signSessionOp(alice, sessionId, peer, join, context);
    expect(
      verifyPayload(
        alice.publicKey,
        SIG_DOMAIN.mail,
        sessionOpPayload(sessionId, peer, join, context),
        proof.sig,
      ),
    ).toBe(false);
    expect(
      verifySessionOp(alice.publicKey, sessionId, peer, join, { ...proof, sig: 'x'.repeat(86) }),
    ).toBe(false);
    expect(verifySessionOp('not a key', sessionId, peer, join, proof)).toBe(false);
  });

  it('means the same with the optional claims left out or undefined', () => {
    const bare: HostCaps = { canHost: false, platform: 'web', nat: 'unknown' };
    const proof = signSessionOp(alice, sessionId, peer, { op: 'join', caps: bare }, context);
    expect(
      verifySessionOp(
        alice.publicKey,
        sessionId,
        peer,
        { op: 'join', caps: { ...bare, uplinkKbps: undefined } },
        proof,
      ),
    ).toBe(true);
  });

  it('needs what its kind of operation carries, and nothing else', () => {
    const update = { op: 'update', caps } as const;
    // The signer will not make one that does not.
    expect(() => signSessionOp(alice, sessionId, peer, join, { ...context, since: 5 })).toThrow();
    expect(() => signSessionOp(alice, sessionId, peer, update, { ...context, since: 5 })).toThrow();
    expect(() => signSessionOp(alice, sessionId, peer, report3, context)).toThrow();
    expect(() =>
      signSessionOp(alice, sessionId, peer, report3, { ...context, since: 5, n: 1 }),
    ).toThrow();
    // And the receiver will not take one, even with a signature that is right for its bytes.
    const bytes = (o: Parameters<typeof sessionOpPayload>[2], p: Omit<SessionOpProof, 'sig'>) => ({
      ...p,
      sig: sign(alice, SIG_DOMAIN.sessionOp, sessionOpPayload(sessionId, peer, o, p)),
    });
    for (const [o, p] of [
      [join, { ...context, since: 5 }],
      [join, { ...context, n: 1 }],
      [update, { ...context, since: 5 }],
      [update, { ...context, n: 1 }],
      [report3, context],
      [report3, { ...context, since: 5, n: 1 }],
    ] as const)
      expect(verifySessionOp(alice.publicKey, sessionId, peer, o, bytes(o, p))).toBe(false);
    const good = bytes(report3, { ...context, since: 5 });
    expect(verifySessionOp(alice.publicKey, sessionId, peer, report3, good)).toBe(true);
  });

  it('signs what a report accuses of, and no other accusation than the ones there are', () => {
    const p = { ...context, since: 5 };
    expect(sessionOpPayload(sessionId, peer, report3, p).op).toMatchObject({
      issue: 'host_unreachable',
    });
    const other = { ...report3, issue: 'other' } as unknown as typeof report3;
    expect(() => sessionOpPayload(sessionId, peer, other, p)).toThrow();
  });

  it('signs the claims as the receiver will have them', () => {
    // A field that is not a claim is dropped by the receiver's parsing; the signature must not depend on it.
    const wide = { ...caps, extra: 'x' } as HostCaps;
    const proof = signSessionOp(alice, sessionId, peer, { op: 'join', caps: wide }, context);
    expect(verifySessionOp(alice.publicKey, sessionId, peer, join, proof)).toBe(true);
    expect(() =>
      signSessionOp(alice, sessionId, peer, { op: 'join', caps: { ...caps, rttMs: NaN } }, context),
    ).toThrow();
  });

  it('does not take an operation it does not sign', () => {
    const leave = { op: 'leave' } as unknown as typeof join;
    const proof = signSessionOp(alice, sessionId, peer, report3, { ...context, since: 5 });
    expect(verifySessionOp(alice.publicKey, sessionId, peer, leave, proof)).toBe(false);
    expect(() => signSessionOp(alice, sessionId, peer, leave, { ...context, since: 5 })).toThrow();
  });

  it('refuses to sign what the schema would refuse, and does not throw on claims that are not claims', () => {
    const update = { op: 'update', caps } as const;
    expect(() =>
      signSessionOp(alice, sessionId, peer, update, { ...context, since: 5, n: 2 ** 31 }),
    ).toThrow();
    expect(() =>
      signSessionOp(alice, sessionId, peer, update, { ...context, since: 5, n: -1 }),
    ).toThrow();
    expect(() => signSessionOp(alice, sessionId, peer, join, { ...context, at: -1 })).toThrow();
    const proof = signSessionOp(alice, sessionId, peer, join, context);
    const bad = { op: 'join', caps: { ...caps, platform: 'toaster' } } as unknown as typeof join;
    expect(verifySessionOp(alice.publicKey, sessionId, peer, bad, proof)).toBe(false);
  });

  it('holds a report to what the schema allows, when signing and when checking', () => {
    for (const epoch of [-1, 1.5, 1e300])
      expect(() =>
        signSessionOp(alice, sessionId, peer, { ...report3, epoch }, { ...context, since: 5 }),
      ).toThrow();
    expect(() =>
      signSessionOp(
        alice,
        sessionId,
        peer,
        { ...report3, issue: 'other' } as unknown as typeof report3,
        { ...context, since: 5 },
      ),
    ).toThrow();
    // A signature that is right for its bytes, over a proof outside the bounds.
    const out = { server: '', at: 1, since: 5 };
    const sig = sign(alice, SIG_DOMAIN.sessionOp, {
      sessionId,
      peer,
      ...out,
      n: null,
      op: report3,
    });
    expect(verifySessionOp(alice.publicKey, sessionId, peer, report3, { ...out, sig })).toBe(false);
  });

  it('says no, and does not throw, when there is no proof', () => {
    expect(verifySessionOp(alice.publicKey, sessionId, peer, join, undefined)).toBe(false);
    expect(verifySessionOp(alice.publicKey, sessionId, peer, join, null as never)).toBe(false);
    const proof = signSessionOp(alice, sessionId, peer, join, context);
    expect(verifySessionOp(alice.publicKey, sessionId, peer, undefined as never, proof)).toBe(
      false,
    );
  });
});
