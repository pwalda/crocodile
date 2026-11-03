import { FILE_BLOCK_SIZE, SignalData } from '@crocodile/protocol';
import type { CoordinatorSettings, RelayProcessIn } from './ipc-types';

/**
 * What the main process takes from the app's page. The page is the app's own (see trust.ts),
 * but what it passes is not taken on trust: a page that has been made to run someone else's
 * script gets no more from these calls than the app itself would ask for. Each function takes
 * what was sent and returns only what is acceptable (or says it is not).
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

const whole = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** The settings of the app's own server that a patch may change, and only to values it accepts. */
export function coordinatorPatch(raw: unknown): Partial<CoordinatorSettings> {
  const out: Partial<CoordinatorSettings> = {};
  if (!isObject(raw)) return out;
  for (const key of ['enabled', 'announce', 'relay', 'mailbox'] as const)
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  // eslint-disable-next-line no-control-regex
  if (text(raw.name, 100) && !/[\u0000-\u001f\u007f-\u009f]/.test(raw.name)) out.name = raw.name;
  if (whole(raw.port, 1, 65535)) out.port = raw.port;
  if (whole(raw.relayMaxUsers, 1, 100)) out.relayMaxUsers = raw.relayMaxUsers;
  // Left out or empty clears them.
  if ('publicUrl' in raw) {
    if (raw.publicUrl === undefined || raw.publicUrl === '') out.publicUrl = undefined;
    else if (text(raw.publicUrl, 200) && webUrl(raw.publicUrl)) out.publicUrl = raw.publicUrl;
  }
  if ('contact' in raw) {
    if (raw.contact === undefined || raw.contact === '') out.contact = undefined;
    else if (text(raw.contact, 200)) out.contact = raw.contact;
  }
  return out;
}

/** The settings after a patch: what was acceptable of it, on top of what is already set. */
export function withCoordinatorPatch(
  current: CoordinatorSettings,
  raw: unknown,
): CoordinatorSettings {
  return { ...current, ...coordinatorPatch(raw) };
}

/** An http or https address, or null. */
export function webUrl(raw: unknown): string | null {
  if (!text(raw, 2048)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A message for the relay process, rebuilt from the parts it uses, or null if it is not one. */
export function relayMessage(raw: unknown): RelayProcessIn | null {
  if (!isObject(raw) || !text(raw.handle, 100)) return null;
  const handle = raw.handle;
  switch (raw.type) {
    case 'start': {
      const { seed, hostPeer, sessionId, epoch, slots, iceServers } = raw;
      if (
        !text(seed, 100) ||
        !text(hostPeer, 200) ||
        !text(sessionId, 200) ||
        !whole(epoch, 0, Number.MAX_SAFE_INTEGER) ||
        !whole(slots, 0, 1000) ||
        !Array.isArray(iceServers) ||
        iceServers.length > 8
      )
        return null;
      const servers: { urls: string }[] = [];
      for (const s of iceServers) {
        if (!isObject(s) || !text(s.urls, 300)) return null;
        servers.push({ urls: s.urls });
      }
      return {
        type: 'start',
        handle,
        seed,
        hostPeer,
        sessionId,
        epoch,
        slots,
        iceServers: servers,
      };
    }
    case 'signal': {
      const data = SignalData.safeParse(raw.data);
      if (!text(raw.from, 200) || !data.success) return null;
      return { type: 'signal', handle, from: raw.from, data: data.data };
    }
    case 'members': {
      const { members } = raw;
      if (!Array.isArray(members) || members.length > 1000 || !members.every((m) => text(m, 200)))
        return null;
      return { type: 'members', handle, members: members as string[] };
    }
    case 'close':
      return { type: 'close', handle };
  }
  return null;
}

/** The number to show on the app's icon: a whole number from none to 99999. */
export function badgeCount(raw: unknown): number {
  return whole(raw, 0, 99_999) ? raw : 0;
}

/** What to do with a file once it is saved. */
export function exportEnding(raw: unknown): 'open' | 'reveal' | 'none' {
  if (raw === 'open' || raw === 'reveal' || raw === 'none') return raw;
  throw new Error('bad ending');
}

/** A name in the secure store: letters, digits and a few marks. */
export function secureKey(raw: unknown): string {
  if (!text(raw, 100) || !/^[A-Za-z0-9._:-]+$/.test(raw)) throw new Error('bad key');
  return raw;
}

/** What the secure store keeps: a seed, keys; never more than a megabyte. */
export function secureValue(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 1024 * 1024) throw new Error('bad value');
  return raw;
}

/** The key chosen for push-to-talk, or none. */
export function pttCode(raw: unknown): string | null {
  if (raw === null) return null;
  if (!text(raw, 64)) throw new Error('bad key');
  return raw;
}

/** The most one chunk of a saved file may be: a block. */
export const MAX_CHUNK = FILE_BLOCK_SIZE;
