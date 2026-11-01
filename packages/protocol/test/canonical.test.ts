import { describe, expect, it } from 'vitest';
import {
  AnonBox,
  ChatMessage,
  E2EEnvelope,
  FileManifest,
  LinkBox,
  SealedBox,
  b64uBytes,
  fromB64u,
  isCanonicalB64u,
  toB64u,
} from '../src';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const bytes = (n: number, fill = 1) => toB64u(new Uint8Array(n).fill(fill));
/** The same bytes spelled with a bit set where nothing is carried. */
const lax = (text: string) => text.slice(0, -1) + alphabet[alphabet.indexOf(text.at(-1)!) | 1]!;

describe('canonical base64url', () => {
  it('agrees with the decoder on every length and on what is left over', () => {
    for (let n = 0; n < 40; n++) {
      const good = bytes(n, 255);
      expect(isCanonicalB64u(good)).toBe(true);
      if (n % 3 === 0) continue; // no spare bits
      const bad = lax(bytes(n, 0));
      expect(isCanonicalB64u(bad)).toBe(false);
      expect(() => fromB64u(bad)).toThrow();
    }
    for (const text of ['a', 'YQ==', 'Y Q', 'YQ.', 'é', 'YR']) {
      expect(isCanonicalB64u(text)).toBe(false);
      expect(() => fromB64u(text)).toThrow();
    }
    expect(isCanonicalB64u('')).toBe(true);
  });

  it('is what a schema for a number of bytes takes', () => {
    const schema = b64uBytes(32);
    expect(schema.safeParse(bytes(32)).success).toBe(true);
    expect(schema.safeParse(lax(bytes(32, 0))).success).toBe(false);
    expect(schema.safeParse(bytes(33)).success).toBe(false);
    expect(schema.safeParse(bytes(31)).success).toBe(false);
  });
});

describe('keys and signatures in messages', () => {
  const key = bytes(32);
  const sig = bytes(64);
  const manifest = { id: bytes(16), name: 'a', size: 1, type: '', key, root: bytes(32) };
  const message = {
    id: 'abcdefghijk',
    ch: 'c',
    author: 'abcdefgh',
    key,
    ts: 1,
    body: '',
    sig,
  };
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
  const link = { epk: key, kem: bytes(1088), ct: bytes(5), from: key, sig };

  const cases: [string, { safeParse: (v: unknown) => { success: boolean } }, object, string[]][] = [
    ['chat message', ChatMessage, message, ['key', 'sig']],
    ['sealed box', SealedBox, sealed, ['epk', 'kem', 'from', 'sig']],
    ['link box', LinkBox, link, ['epk', 'kem', 'from', 'sig']],
    ['file manifest', FileManifest, manifest, ['id', 'key', 'root']],
  ];
  for (const [name, schema, good, fields] of cases) {
    it(`a ${name} takes one spelling of each key and signature`, () => {
      expect(schema.safeParse(good).success).toBe(true);
      for (const field of fields) {
        const value = (good as Record<string, string>)[field]!;
        expect(
          schema.safeParse({ ...good, [field]: lax(bytes(fromB64u(value).length, 0)) }).success,
        ).toBe(false);
        expect(schema.safeParse({ ...good, [field]: value.slice(1) }).success).toBe(false);
        expect(schema.safeParse({ ...good, [field]: value + 'A' }).success).toBe(false);
      }
    });
  }

  it('takes one spelling of a ciphertext, of any length', () => {
    const ct = bytes(5);
    for (const [schema, good] of [
      [SealedBox, sealed],
      [LinkBox, link],
      [E2EEnvelope, { k: 'group', kid: 1, g: 0, ct }],
      [AnonBox, { v: 3, to: sealed.to, pk: 0, epk: key, kem: bytes(1088), ct }],
    ] as const) {
      expect(schema.safeParse({ ...good, ct }).success).toBe(true);
      expect(schema.safeParse({ ...good, ct: lax(ct) }).success).toBe(false);
      expect(schema.safeParse({ ...good, ct: ct + '=' }).success).toBe(false);
    }
  });
});
