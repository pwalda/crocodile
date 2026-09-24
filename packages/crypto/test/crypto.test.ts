import { describe, expect, it } from 'vitest';
import { recordKey, type SignedRecord, utf8 } from '@crocodile/protocol';
import {
  createChatMessage,
  createIdentity,
  createSenderKey,
  decodeRecoveryKey,
  decryptFrame,
  decryptGroup,
  deriveSenderKey,
  encodeRecoveryKey,
  encryptFrame,
  encryptGroup,
  identityFromSeed,
  isSpaceMember,
  openSealed,
  peekFrameKid,
  randomId,
  safetyNumber,
  seal,
  signRecord,
  signSdp,
  spaceIdFor,
  validateRecord,
  verifyChatMessage,
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
    signRecord(who, 'profile', recordKey.profile(who.userId), { username: 'alice', encKey: who.encPublicKey });

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
    const v1 = signRecord(alice, 'profile', recordKey.profile(alice.userId), { username: 'a', encKey: alice.encPublicKey }, Date.now() - 1000);
    const v2 = signRecord(alice, 'profile', recordKey.profile(alice.userId), { username: 'b', encKey: alice.encPublicKey });
    expect(validateRecord(v1, ctx([v2]))).toMatchObject({ ok: false, reason: 'stale version' });
    expect(validateRecord(v2, ctx([v1])).ok).toBe(true);
  });

  it('binds spaces to their owner and gates membership on invites', () => {
    const nonce = randomId();
    const spaceId = spaceIdFor(alice.publicKey, nonce);
    const space = signRecord(alice, 'space', recordKey.space(spaceId), {
      name: 'Swamp',
      owner: alice.userId,
      nonce,
      admins: [],
      bans: [],
      channels: [{ id: randomId(), name: 'general', kind: 'text' }],
    });
    expect(validateRecord(space, ctx([])).ok).toBe(true);

    const hijack = signRecord(mallory, 'space', recordKey.space(spaceId), { ...space.body, owner: mallory.userId });
    expect(validateRecord(hijack, ctx([space])).ok).toBe(false);

    const code = randomId(5);
    const invite = signRecord(alice, 'invite', recordKey.invite(code), { spaceId, code, expiresAt: null });
    expect(validateRecord(invite, ctx([space])).ok).toBe(true);
    const fakeInvite = signRecord(mallory, 'invite', recordKey.invite(code), { spaceId, code, expiresAt: null });
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
});

describe('sealed boxes', () => {
  it('only the recipient can open and the sender is authenticated', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const eve = createIdentity();
    const box = seal(alice, bob.encPublicKey, utf8.encode('hello bob'));
    const opened = openSealed(bob, box);
    expect(opened?.from).toBe(alice.userId);
    expect(utf8.decode(opened!.plaintext)).toBe('hello bob');
    expect(openSealed(eve, box)).toBeNull();
    expect(openSealed(bob, { ...box, from: eve.publicKey })).toBeNull();
  });
});

describe('sender keys', () => {
  it('encrypts and decrypts voice frames', () => {
    const key = deriveSenderKey(createSenderKey());
    const frame = Uint8Array.from({ length: 80 }, (_, i) => i);
    const enc = encryptFrame(key, 42, frame);
    expect(peekFrameKid(enc)).toBe(key.kid);
    expect(decryptFrame(key, enc)).toEqual(frame);
    enc[3] = enc[3]! ^ 1;
    expect(decryptFrame(key, enc)).toBeNull();
    expect(decryptFrame(deriveSenderKey(createSenderKey()), encryptFrame(key, 1, frame))).toBeNull();
  });

  it('encrypts group text', () => {
    const key = deriveSenderKey(createSenderKey());
    const env = encryptGroup(key, 7, utf8.encode('hi all'));
    expect(utf8.decode(decryptGroup(key, env.n, env.ct)!)).toBe('hi all');
    expect(decryptGroup(key, env.n + 1, env.ct)).toBeNull();
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

  it('binds SDP to session and identities', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const offer = signSdp(alice, 'offer', { sessionId: 's', epoch: 1, to: bob.userId }, 'v=0...');
    expect(verifySdp(offer, { sessionId: 's', from: alice.userId, to: bob.userId })).toBe(true);
    expect(verifySdp(offer, { sessionId: 'other', from: alice.userId, to: bob.userId })).toBe(false);
    expect(verifySdp({ ...offer, sdp: 'v=0 evil' }, { sessionId: 's', from: alice.userId, to: bob.userId })).toBe(false);
  });
});
