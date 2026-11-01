/**
 * Platform-neutral byte encodings. Everything here must run unchanged in Node,
 * browsers (Electron renderer) and React Native, so no Buffer / btoa.
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64URL.length; i++) B64URL_LOOKUP[B64URL.charCodeAt(i)] = i;

export function toB64u(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** Why `text` is not what toB64u would write for some bytes, or null if it is. */
function b64uProblem(text: string): string | null {
  if (text.length % 4 === 1) return 'invalid base64url length';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    last = code < 128 ? B64URL_LOOKUP[code]! : -1;
    if (last < 0) return 'invalid base64url character';
  }
  // Only what toB64u writes: no padding, and the unused bits of the last character zero. Any
  // other spelling of the same bytes would let one key or signature wear several names.
  const spare = (text.length * 6) % 8;
  return spare === 0 || (last & ((1 << spare) - 1)) === 0 ? null : 'invalid base64url padding bits';
}

/** Whether `text` is exactly what toB64u would write for some bytes (what fromB64u accepts). */
export function isCanonicalB64u(text: string): boolean {
  return b64uProblem(text) === null;
}

export function fromB64u(text: string): Uint8Array {
  const problem = b64uProblem(text);
  if (problem) throw new Error(problem);
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    buffer = ((buffer << 6) | B64URL_LOOKUP[text.charCodeAt(i)]!) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. */
export function toB32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

const B32_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < B32.length; i++) B32_LOOKUP[B32.charCodeAt(i)] = i;

/** The value of a base32 character, upper or lower case (ASCII only), or -1. */
function b32Value(code: number) {
  if (code >= 65 && code <= 90) code += 32;
  return code < 128 ? B32_LOOKUP[code]! : -1;
}

/** Why `text` is not what toB32 would write for some bytes (in either case), or null if it is. */
function b32Problem(text: string): string | null {
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    last = b32Value(text.charCodeAt(i));
    if (last < 0) return 'invalid base32 character';
  }
  // The bits of the last character that carry nothing must be zero, or one value has many spellings.
  const spare = (text.length * 5) % 8;
  return spare === 0 || (last & ((1 << spare) - 1)) === 0 ? null : 'invalid base32 padding bits';
}

/** Whether `text` is what toB32 would write for some bytes, in either case. */
export function isCanonicalB32(text: string): boolean {
  return b32Problem(text) === null;
}

/** ASCII case does not matter; anything but the 32 letters and digits, and unused bits that are not zero, is an error. */
export function fromB32(text: string): Uint8Array {
  const problem = b32Problem(text);
  if (problem) throw new Error(problem);
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    buffer = ((buffer << 5) | b32Value(text.charCodeAt(i))) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = {
  encode: (text: string): Uint8Array => encoder.encode(text),
  decode: (bytes: Uint8Array): string => decoder.decode(bytes),
};

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Used for everything
 * that gets signed so that signer and verifier hash identical bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}
