import { openDB, type IDBPDatabase } from 'idb';
import {
  browserCapabilities,
  detectNat,
  type HostRelayAdapter,
  type KeyValueStore,
  type MessageStore,
  type PlatformAdapter,
  type RelayHandle,
} from '@crocodile/client-core';
import { randomId } from '@crocodile/crypto';
import { toB64u, type ChatMessage, type NatType, type SignalData } from '@crocodile/protocol';
import type { DesktopApi } from '../preload/preload';

declare global {
  interface Window {
    crocodile?: DesktopApi;
  }
}

export const desktop = window.crocodile;

interface Schema {
  kv: { key: string; value: unknown };
  messages: { key: string; value: ChatMessage; indexes: { byChannelTs: [string, number] } };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | undefined;
function db() {
  dbPromise ??= openDB<Schema>('crocodile', 1, {
    upgrade(d) {
      d.createObjectStore('kv');
      const messages = d.createObjectStore('messages', { keyPath: 'id' });
      messages.createIndex('byChannelTs', ['ch', 'ts']);
    },
  });
  return dbPromise;
}

/** Secrets go to the OS keychain through the main process; the rest to IndexedDB. */
const SECURE_KEYS = new Set(['identity-seed']);

export const kv: KeyValueStore = {
  async get<T>(key: string) {
    if (SECURE_KEYS.has(key) && desktop) {
      const v = await desktop.secure.get(key);
      return (v === undefined ? undefined : JSON.parse(v)) as T | undefined;
    }
    return (await (await db()).get('kv', key)) as T | undefined;
  },
  async set<T>(key: string, value: T) {
    if (SECURE_KEYS.has(key) && desktop) return desktop.secure.set(key, JSON.stringify(value));
    await (await db()).put('kv', value, key);
  },
  async delete(key: string) {
    if (SECURE_KEYS.has(key) && desktop) return desktop.secure.delete(key);
    await (await db()).delete('kv', key);
  },
};

export const messages: MessageStore = {
  async put(message) {
    const d = await db();
    const tx = d.transaction('messages', 'readwrite');
    if (await tx.store.get(message.id)) {
      await tx.done;
      return false;
    }
    await tx.store.put(message);
    await tx.done;
    return true;
  },
  async page(channel, { before, limit }) {
    const d = await db();
    const range = IDBKeyRange.bound(
      [channel, 0],
      [channel, before === undefined ? Number.MAX_SAFE_INTEGER : before],
      false,
      true,
    );
    const out: ChatMessage[] = [];
    let cursor = await d
      .transaction('messages')
      .store.index('byChannelTs')
      .openCursor(range, 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out.reverse();
  },
  async since(channel, after, limit) {
    const d = await db();
    const range = IDBKeyRange.bound(
      [channel, after],
      [channel, Number.MAX_SAFE_INTEGER],
      true,
      false,
    );
    return (await d.getAllFromIndex('messages', 'byChannelTs', range, limit)) as ChatMessage[];
  },
  async latestTs(channel) {
    const page = await this.page(channel, { limit: 1 });
    return page[0]?.ts ?? 0;
  },
};

/** Runs host relays in the Electron utility process. */
function relayAdapter(api: DesktopApi): HostRelayAdapter {
  const outbound = new Map<string, (to: string, data: SignalData) => void>();
  api.relay.onEvent((msg) => {
    if (msg.type === 'signal') outbound.get(msg.handle)?.(msg.to, msg.data);
    else if (msg.type === 'error') console.warn('relay error', msg.message);
  });
  return {
    async start(opts) {
      const handle = randomId(6);
      outbound.set(handle, opts.sendSignal);
      await api.relay.send({
        type: 'start',
        handle,
        seed: toB64u(opts.identity.seed),
        sessionId: opts.sessionId,
        epoch: opts.epoch,
        slots: opts.slots,
        iceServers: opts.iceServers,
      });
      const pushMembers = () =>
        void api.relay.send({ type: 'members', handle, members: opts.members() });
      pushMembers();
      const timer = setInterval(pushMembers, 2000);
      return {
        handleSignal(from, data) {
          if (data.type === 'offer') pushMembers();
          void api.relay.send({ type: 'signal', handle, from, data });
        },
        async close() {
          clearInterval(timer);
          outbound.delete(handle);
          await api.relay.send({ type: 'close', handle });
        },
      } satisfies RelayHandle;
    },
  };
}

let natCache: { at: number; nat: NatType } | undefined;

export function createPlatform(opts: {
  version: string;
  cpuCores?: number;
  stun: () => string[];
}): PlatformAdapter {
  return {
    platform: desktop ? 'desktop' : 'web',
    appVersion: opts.version,
    kv,
    messages,
    ...(desktop ? { relay: relayAdapter(desktop) } : {}),
    rtc: { RTCPeerConnection, getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) },
    async capabilities() {
      const caps = await browserCapabilities();
      if (!natCache || Date.now() - natCache.at > 10 * 60_000) {
        const stun = opts.stun();
        const probes = [...stun, 'stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
        natCache = {
          at: Date.now(),
          nat: await detectNat(RTCPeerConnection, probes).catch(() => 'unknown' as const),
        };
      }
      return { ...caps, cpuCores: opts.cpuCores ?? caps.cpuCores, nat: natCache.nat };
    },
  };
}
