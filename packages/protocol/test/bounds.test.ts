import { describe, expect, it } from 'vitest';
import {
  ChatMessage,
  E2EEnvelope,
  FileManifest,
  InviteBody,
  LIMITS,
  MemberBody,
  SealedBox,
  SealedPayload,
  ServerInfo,
  toB64u,
} from '../src';

const bytes = (n: number, fill = 1) => toB64u(new Uint8Array(n).fill(fill));
/** A ciphertext of at least this many characters: exactly that many when a whole number of bytes. */
const ctOf = (chars: number) => bytes(Math.ceil((chars * 3) / 4));
const key = bytes(32);
const sig = bytes(64);

const sealed = {
  v: 3,
  to: 'abcdefghij.klmnopqrst',
  pk: 0,
  epk: key,
  kem: bytes(1088),
  ct: bytes(5),
  from: key,
  fromDevice: 'abcdefgh',
  sig,
};
const manifest = { id: bytes(16), name: 'a.txt', size: 1, type: '', key, root: bytes(32) };
const message = { id: 'abcdefghijk', ch: 'c', author: 'abcdefgh', key, ts: 1, body: '', sig };

describe('how long a ciphertext may be', () => {
  it('a sealed box takes what a mailbox holds, and no more', () => {
    const limit = LIMITS.sealedBoxMaxChars;
    expect(SealedBox.safeParse({ ...sealed, ct: ctOf(limit) }).success).toBe(true);
    expect(SealedBox.safeParse({ ...sealed, ct: ctOf(limit + 1) }).success).toBe(false);
    // Refused on its length alone: the text is not read.
    const result = SealedBox.safeParse({ ...sealed, ct: '!'.repeat(limit * 4) });
    expect(result.error!.issues.map((i) => i.code)).toEqual(['too_big']);
  });

  it('a group message takes what a data channel message holds, and no more', () => {
    const limit = LIMITS.groupCiphertextMaxChars;
    const envelope = (ct: string) => ({ k: 'group', kid: 1, g: 0, ct });
    expect(E2EEnvelope.safeParse(envelope(ctOf(limit))).success).toBe(true);
    expect(E2EEnvelope.safeParse(envelope(ctOf(limit + 1))).success).toBe(false);
  });

  it('the limits leave room for the largest thing a client sends', () => {
    // Sealed and encoded: 12 bytes of nonce and 16 of tag, then 4 characters for 3 bytes.
    const chars = (plain: number) => Math.ceil(((plain + 28) * 4) / 3);
    // A full mailbox chunk of messages (client-core's MAIL_BOX_BYTES) and a history chunk.
    expect(chars(48 * 1024)).toBeLessThan(LIMITS.sealedBoxMaxChars);
    // The longest message the schema admits: every character of the body written as \u0000, which
    // is six bytes of JSON each, a caption, and a file with the longest name and preview.
    const worst = ChatMessage.parse({
      ...message,
      id: 'x'.repeat(40),
      ch: 'c'.repeat(200),
      sid: 's'.repeat(200),
      body: '\u0000'.repeat(LIMITS.messageMaxChars),
      replyTo: 'r'.repeat(40),
      edits: 'e'.repeat(40),
      file: {
        ...manifest,
        name: 'Ā'.repeat(255),
        type: 't'.repeat(127),
        thumb: 'data:image/png;base64,' + 'A'.repeat(3978),
      },
    });
    const plain = new TextEncoder().encode(JSON.stringify({ k: 'message', message: worst })).length;
    expect(chars(plain)).toBeLessThan(LIMITS.groupCiphertextMaxChars);
  });
});

describe('messages in a reply', () => {
  const bad = { ...message, file: { ...manifest, name: 'a/b' } };
  const good = { ...message, id: 'bcdefghijkl' };

  it('leaves out one the schema refuses and keeps the others', () => {
    for (const type of ['history', 'mail'] as const) {
      const parsed = SealedPayload.parse({
        type,
        messages: [good, bad, { nonsense: true }, null, good],
        ...(type === 'history' ? { done: true } : {}),
      });
      expect(parsed.type === 'history' || parsed.type === 'mail').toBe(true);
      const kept = (parsed as { messages: { id: string }[] }).messages;
      expect(kept.map((m) => m.id)).toEqual([good.id, good.id]);
    }
  });

  it('still takes only so many, and only a list', () => {
    const many = (n: number) => Array.from({ length: n }, () => good);
    const history = (messages: unknown) =>
      SealedPayload.safeParse({ type: 'history', messages, done: true }).success;
    expect(history(many(500))).toBe(true);
    expect(history(many(501))).toBe(false);
    expect(history('nope')).toBe(false);
    expect(history({ 0: good })).toBe(false);
    expect(SealedPayload.safeParse({ type: 'mail', messages: many(51) }).success).toBe(false);
  });
});

describe('invite codes', () => {
  const code = 'abcdefgh23456abcdefgh23456'; // 26 characters, like an open link's
  const member = { spaceId: 'abcdefgh', userId: 'abcdefgh' };

  it('a membership names an invite as an invite does', () => {
    expect(MemberBody.safeParse({ ...member, inviteCode: code }).success).toBe(true);
    for (const bad of [
      '',
      'abc',
      'a'.repeat(33),
      'A'.repeat(26),
      'a1'.repeat(10),
      'a'.repeat(25) + '\n',
      'a'.repeat(100_000),
    ])
      expect(MemberBody.safeParse({ ...member, inviteCode: bad }).success, bad.slice(0, 40)).toBe(
        false,
      );
    expect(MemberBody.safeParse(member).success).toBe(true);
  });

  it('is the same rule an invite record has for its code', () => {
    const invite = { spaceId: 'abcdefgh', code, expiresAt: null };
    expect(InviteBody.safeParse(invite).success).toBe(true);
    expect(InviteBody.safeParse({ ...invite, code: 'a'.repeat(33) }).success).toBe(false);
  });
});

describe('history requests', () => {
  const request = (since: Record<string, number>) =>
    SealedPayload.safeParse({ type: 'history_req', since });
  const channels = (n: number, key = (i: number) => `ch${i}`) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i), 1_700_000_000_000]));

  it('names at most as many channels as a space has', () => {
    expect(request(channels(LIMITS.channelsPerSpace)).success).toBe(true);
    expect(request(channels(LIMITS.channelsPerSpace + 1)).success).toBe(false);
    expect(request({}).success).toBe(true);
  });

  it('names a channel as a message does', () => {
    expect(request({ ['c'.repeat(200)]: 1 }).success).toBe(true);
    expect(request({ ['c'.repeat(201)]: 1 }).success).toBe(false);
  });

  it('gives whole timestamps', () => {
    expect(request({ c: 1.5 }).success).toBe(false);
    expect(request({ c: Number.NaN }).success).toBe(false);
    expect(request({ c: '1' as unknown as number }).success).toBe(false);
  });
});

describe('file names', () => {
  const named = (name: string) => FileManifest.safeParse({ ...manifest, name }).success;

  it('refuses a folder, a control character or a direction override', () => {
    for (const bad of [
      '../a',
      'a/b',
      'a\\b',
      'a\u0000b',
      'a\nb',
      'a\u007fb',
      'evil‮gnp.exe',
      'a‪b',
      'a⁦b',
      'a⁩b',
    ])
      expect(named(bad), JSON.stringify(bad)).toBe(false);
  });

  it('takes any other name, in any script', () => {
    for (const good of [
      'a.txt',
      'my file (1).tar.gz',
      '日本語.pdf',
      'ż'.repeat(120),
      '.hidden',
      'a‏b', // a right-to-left mark in a Hebrew or Arabic name
      'con.txt',
      'a:b',
    ])
      expect(named(good), good).toBe(true);
    expect(named('')).toBe(false);
    expect(named('a'.repeat(256))).toBe(false);
  });
});

describe('where a server says it is', () => {
  const info = { id: 'abcdefgh', key, name: 'a', version: '1' };
  const at = (url: string) => ServerInfo.safeParse({ ...info, url }).success;

  it('is an http or https address, and nothing else', () => {
    for (const good of ['https://croc.example.org', 'http://203.0.113.4:7443', 'HTTPS://A.EXAMPLE'])
      expect(at(good), good).toBe(true);
    for (const bad of [
      'file:///etc/passwd',
      'ftp://example.org',
      'ws://example.org',
      'javascript:alert(1)',
      'data:text/plain,a',
      'not a url',
      '',
    ])
      expect(at(bad), bad).toBe(false);
  });
});
