import {
  PublicDirectoryEntry,
  SIG_DOMAIN,
  fromB64u,
  toB64u,
  utf8,
  type DirectoryEntry,
  type PublicServerInfo,
  type ServerInfo,
} from '@crocodile/protocol';
import { keyMatchesUserId } from './identity';
import { pad, unpad } from './padding';
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, randomBytes, verifyPayload } from './primitives';

/**
 * Server addresses in public listings (directory, server info) are
 * obfuscated: encrypted with a key every Crocodile app knows, padded, with a
 * fresh nonce each time so the same address never shows as the same text.
 * This keeps IPs out of search engines and casual scraping; it is not
 * secret from anyone who runs the (open-source) app.
 */
const ADDRESS_KEY = hkdfSha256(
  utf8.encode('crocodile public server addresses'),
  new Uint8Array(0),
  'croc/v1/directory-address',
  32,
);
const PREFIX = 'a1.';

export function encodeServerAddress(url: string): string {
  const nonce = randomBytes(12);
  const ct = aesGcmEncrypt(ADDRESS_KEY, nonce, pad(utf8.encode(url)), utf8.encode(PREFIX));
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return PREFIX + toB64u(out);
}

/** The address behind `addr`, or null if it isn't a valid encoding. */
export function decodeServerAddress(addr: string): string | null {
  if (!addr.startsWith(PREFIX)) return null;
  let raw: Uint8Array;
  try {
    raw = fromB64u(addr.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (raw.length < 12 + 16) return null;
  const padded = aesGcmDecrypt(
    ADDRESS_KEY,
    raw.subarray(0, 12),
    raw.subarray(12),
    utf8.encode(PREFIX),
  );
  const plain = padded && unpad(padded);
  if (!plain) return null;
  const url = utf8.decode(plain);
  return /^https?:\/\//.test(url) ? url : null;
}

export function toPublicServerInfo({ url, ...rest }: ServerInfo): PublicServerInfo {
  return { ...rest, addr: encodeServerAddress(url) };
}

export function fromPublicServerInfo({ addr, ...rest }: PublicServerInfo): ServerInfo | null {
  const url = decodeServerAddress(addr);
  return url ? { ...rest, url } : null;
}

export function toPublicDirectoryEntry(
  e: DirectoryEntry & { lastSeen: number },
): PublicDirectoryEntry {
  return { ...e, server: toPublicServerInfo(e.server) };
}

/**
 * Decode a listing entry and check the server's own signature over its real
 * details, so neither the directory nor anyone in between can redirect apps
 * to another address. Returns null for anything that doesn't check out.
 */
export function openDirectoryEntry(raw: unknown): (DirectoryEntry & { lastSeen: number }) | null {
  const parsed = PublicDirectoryEntry.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const server = fromPublicServerInfo(e.server);
  if (!server || !keyMatchesUserId(server.key, server.id)) return null;
  const signed = { server, load: e.load, signedAt: e.signedAt };
  if (!verifyPayload(server.key, SIG_DOMAIN.directory, signed, e.sig)) return null;
  return { server, load: e.load, signedAt: e.signedAt, sig: e.sig, lastSeen: e.lastSeen };
}
