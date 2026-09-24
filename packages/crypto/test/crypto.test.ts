import { describe, expect, it } from 'vitest';
import { recordKey, type SignedRecord, utf8 } from '@crocodile/protocol';
import {
  AudioReceiver,
  AudioSender,
  PREKEY_LIFETIME_MS,
  SecureChannel,
  TextReceiver,
  acceptChannel,
  answerChannel,
  createChannelKeys,
  createPrekey,
  encryptText,
  exportChains,
  importChain,
  linkSecurityCode,
  openLink,
  padmeLength,
  ratchet,
  rotatePrekeys,
  sealLink,
  sealToDevice,
  userIdFromKey,
  createChatMessage,
  createIdentity,
  createSenderKey,
  decodeRecoveryKey,
  encodeRecoveryKey,
  identityFromSeed,
  isSpaceMember,
  openSealed,
  peekFrameKid,
  randomId,
  safetyNumber,
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

    const hijack = signRecord(mallory, 'space', recordKey.space(spaceId), {
      ...space.body,
      owner: mallory.userId,
    });
    expect(validateRecord(hijack, ctx([space])).ok).toBe(false);

    const code = randomId(5);
    const invite = signRecord(alice, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
    });
    expect(validateRecord(invite, ctx([space])).ok).toBe(true);
    const fakeInvite = signRecord(mallory, 'invite', recordKey.invite(code), {
      spaceId,
      code,
      expiresAt: null,
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

  it('links devices: only the new device opens, and the security codes agree', () => {
    const account = createIdentity();
    const temp = createIdentity();
    const box = sealLink(account, temp.encPublicKey, account.seed);
    expect(openLink(temp, box, account.userId)).toEqual(account.seed);
    expect(openLink(temp, box, createIdentity().userId)).toBeNull();
    expect(openLink(createIdentity(), box, account.userId)).toBeNull();
    expect(linkSecurityCode(temp.publicKey, account.publicKey)).toMatch(/^\d{3} \d{3}$/);
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
