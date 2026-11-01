import { describe, expect, it } from 'vitest';
import {
  AnonBox,
  FedFrameSchema,
  MemberBody,
  ClientAuth,
  fromB32,
  isCanonicalB32,
  toB32,
  b64uText,
  keyB64u,
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

describe('keys and signatures between servers', () => {
  const key = bytes(32);
  const sig = bytes(64);
  const frames: Record<string, object> = {
    beacon: { t: 'beacon', server: {}, seq: 1, full: false, sig },
    presence: { t: 'presence', origin: 'abcdefgh', seq: 1, full: false, entries: [], key, sig },
    fed_auth: {
      t: 'fed_auth',
      answer: { epk: key, kem: bytes(1088) },
      sig,
      cursor: 0,
    },
    voice: {
      t: 'voice',
      sessionId: 'voice:abcdefgh:abcdefgh',
      occ: { spaceId: 'abcdefgh', channelId: 'abcdefgh', members: [], host: null },
      owner: 'abcdefgh',
      at: 1,
      key,
      sig,
    },
    x: { t: 'x', n: 1, c: bytes(5) },
    link_answer: {
      t: 'flood',
      id: 'abcdefgh',
      origin: 'abcdefgh',
      hops: 1,
      f: {
        t: 'link_answer',
        qid: 'abcdefgh',
        found: {
          peer: 'abcdefghij.klmnopqrst',
          key,
          encKey: key,
          kemKey: bytes(1184),
          commit: key,
        },
      },
    },
  };
  const changed = (value: unknown, path: string[]): unknown => {
    if (path.length === 0) return typeof value === 'string' ? lax(value) : value;
    const [head, ...rest] = path;
    return {
      ...(value as object),
      [head!]: changed((value as Record<string, unknown>)[head!], rest),
    };
  };
  const fields: [string, string[]][] = [
    ['beacon', ['sig']],
    ['presence', ['key']],
    ['presence', ['sig']],
    ['fed_auth', ['sig']],
    ['fed_auth', ['answer', 'epk']],
    ['voice', ['key']],
    ['voice', ['sig']],
    ['link_answer', ['f', 'found', 'key']],
    ['link_answer', ['f', 'found', 'encKey']],
    ['link_answer', ['f', 'found', 'kemKey']],
    ['link_answer', ['f', 'found', 'commit']],
    ['x', ['c']],
  ];

  it('takes each frame as the servers write it, and refuses another spelling of a field', () => {
    for (const [name, frame] of Object.entries(frames))
      expect(FedFrameSchema.safeParse(frame).success, name).toBe(true);
    for (const [name, path] of fields)
      expect(
        FedFrameSchema.safeParse(changed(frames[name], path)).success,
        `${name} ${path.join('.')}`,
      ).toBe(false);
  });

  it('refuses a sign-in whose sealed frame is in another spelling', () => {
    const auth = {
      t: 'auth',
      channel: { epk: key, kem: bytes(1088) },
      sealed: { n: 0, c: bytes(5) },
    };
    expect(ClientAuth.safeParse(auth).success).toBe(true);
    expect(ClientAuth.safeParse({ ...auth, sealed: { n: 0, c: lax(bytes(5)) } }).success).toBe(
      false,
    );
  });

  it('refuses a key that is too long without scanning it', () => {
    const result = keyB64u.safeParse('!'.repeat(1000));
    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
  });

  it('refuses a ticket proof in another spelling', () => {
    const proofOnly = MemberBody.shape.ticket.unwrap().shape.proof;
    expect(proofOnly.safeParse(sig).success).toBe(true);
    expect(proofOnly.safeParse(lax(sig)).success).toBe(false);
  });
});

describe('base32 and long ciphertexts', () => {
  it('tells a canonical base32 text from another, in either case', () => {
    for (let n = 0; n < 40; n++) {
      const text = toB32(Uint8Array.from({ length: n }, (_, i) => (i * 29 + 5) & 0xff));
      expect(isCanonicalB32(text)).toBe(true);
      expect(isCanonicalB32(text.toUpperCase())).toBe(true);
    }
    expect(isCanonicalB32('ab-')).toBe(false);
    expect(isCanonicalB32('\u212aa')).toBe(false);
    // A length toB32 never writes (1, 3 or 6 of 8 characters hold bits that make no byte), and
    // 2 characters with a bit set that carries nothing.
    for (const odd of ['a', 'b', 'aaa', 'aaaaaa']) {
      expect(isCanonicalB32(odd)).toBe(false);
      expect(() => fromB32(odd)).toThrow(/invalid base32/);
    }
    expect(isCanonicalB32('aa')).toBe(true);
    expect(isCanonicalB32('ab')).toBe(false);
  });

  it('refuses a ciphertext that is too long without reading it', () => {
    // A string that is too long and also not base64url fails on its length alone.
    const result = b64uText(8).safeParse('!'.repeat(1000));
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.code)).toEqual(['too_big']);
    expect(b64uText(8).safeParse('YQ').success).toBe(true);
    expect(b64uText().safeParse('YQ').success).toBe(true);
  });
});
