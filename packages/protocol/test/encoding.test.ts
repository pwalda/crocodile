import { describe, expect, it } from 'vitest';
import {
  FedFrameSchema,
  canonicalJson,
  isOperatorContact,
  fromB32,
  fromB64u,
  parseSessionId,
  sessionIds,
  toB32,
  toB64u,
} from '../src';

describe('encoding', () => {
  it('round-trips base64url for all lengths', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = toB64u(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(fromB64u(text)).toEqual(bytes);
    }
  });

  it('takes one spelling of each value: no padding, unused bits zero', () => {
    expect(fromB64u('YQ')).toEqual(new TextEncoder().encode('a'));
    // 'YQ' is "a"; 'YR' has the same bytes with a bit set that carries nothing.
    expect(() => fromB64u('YR')).toThrow(/padding bits/);
    expect(() => fromB64u('YQ==')).toThrow(/character/);
    // A 64-byte signature leaves 4 bits over: 16 spellings before, one now.
    const sig = Uint8Array.from({ length: 64 }, (_, i) => i);
    const text = toB64u(sig);
    expect(fromB64u(text)).toEqual(sig);
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(
      text[85]!,
    );
    const other = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[last ^ 1]!;
    expect(() => fromB64u(text.slice(0, 85) + other)).toThrow(/padding bits/);
  });

  it('rejects hostile input quickly', () => {
    // Signatures and keys from the network reach this decoder before any length
    // check; a run of '=' once cost quadratic time (it took ~30 s).
    const start = performance.now();
    expect(() => fromB64u('='.repeat(200_000) + '!')).toThrow();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('takes one spelling of each base32 value, in either case', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const text = toB32(bytes);
    expect(text).toHaveLength(52);
    expect(fromB32(text.toUpperCase())).toEqual(bytes);
    // 52 characters hold 260 bits; the last 4 must be zero.
    expect(() => fromB32(text.slice(0, 51) + 'b')).toThrow(/padding bits/);
    expect(() => fromB32(text + '=')).toThrow(/character/);
    expect(() => fromB32(text.slice(0, 10) + '-' + text.slice(10))).toThrow(/character/);
    expect(() => fromB32('a1')).toThrow(/character/);
    // U+212A (Kelvin sign) lowercases to 'k': not a second spelling of it.
    expect(() => fromB32('\u212aa')).toThrow(/character/);
    expect(fromB32('KA')).toEqual(fromB32('ka'));
  });

  it('round-trips base32', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 91 + 7) & 0xff);
      expect(fromB32(toB32(bytes))).toEqual(bytes);
    }
  });

  it('produces canonical JSON independent of key order', () => {
    const a = canonicalJson({ b: 1, a: [{ y: 2, x: 'z' }], c: undefined });
    const b = canonicalJson({ a: [{ x: 'z', y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"x":"z","y":2}],"b":1}');
  });
});

describe('session ids', () => {
  it('parses scopes and normalises dm order', () => {
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(sessionIds.dm(b, a)).toBe(`dm:${a}:${b}`);
    expect(parseSessionId(sessionIds.dm(b, a))).toEqual({ kind: 'dm', users: [a, b] });
    expect(parseSessionId(`dm:${b}:${a}`)).toBeNull();
    expect(parseSessionId(sessionIds.voice(a, b))).toEqual({
      kind: 'voice',
      spaceId: a,
      channelId: b,
    });
    expect(parseSessionId('space:NOPE')).toBeNull();
  });
});

describe('operator contact', () => {
  it('accepts an email address or an https page, nothing else', () => {
    for (const ok of ['ops@example.org', 'https://example.org/privacy/'])
      expect(isOperatorContact(ok)).toBe(true);
    for (const bad of [
      '',
      'http://example.org',
      'https:example.org',
      'https:/example.org',
      'javascript:alert(1)',
      'mailto:ops@example.org',
      'ops@example',
      'ops @example.org',
      `https://example.org/${'a'.repeat(200)}`,
    ])
      expect(isOperatorContact(bad)).toBe(false);
  });
});

describe('link lookups between servers', () => {
  const peer = `${'a'.repeat(52)}.${'b'.repeat(8)}`;
  const query = {
    t: 'flood',
    id: 'q',
    origin: 's',
    hops: 0,
    f: { t: 'link_query', qid: 'q', code: 'ABCD-EFGH' },
  };

  it('name the claiming device, so a reveal can go only to it', () => {
    expect(FedFrameSchema.safeParse(query).success).toBe(false);
    expect(FedFrameSchema.safeParse({ ...query, f: { ...query.f, by: peer } }).success).toBe(true);
  });
});
