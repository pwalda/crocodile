import type { ChatMessage, HostCaps, Platform, SignalData } from '@crocodile/protocol';
import type { Identity } from '@crocodile/crypto';

/** Small async key-value store (settings, identity, caches). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Local message history. Text never lives anywhere but on peers. */
export interface MessageStore {
  /** Returns false if the message id was already stored. */
  put(message: ChatMessage): Promise<boolean>;
  /** Newest-last page of messages older than `before` (exclusive). */
  page(channel: string, opts: { before?: number; limit: number }): Promise<ChatMessage[]>;
  /** Messages newer than `after`, oldest first. */
  since(channel: string, after: number, limit: number): Promise<ChatMessage[]>;
  latestTs(channel: string): Promise<number>;
}

/** A running relay for a session this device hosts. */
export interface RelayHandle {
  handleSignal(from: string, data: SignalData): void;
  close(): Promise<void>;
}

export interface RelayStartOptions {
  sessionId: string;
  epoch: number;
  identity: Identity;
  slots: number;
  iceServers: { urls: string }[];
  /** Members allowed to connect; checked on every offer. */
  members: () => string[];
  sendSignal: (to: string, data: SignalData) => void;
}

/**
 * Runs the host relay. Desktop implements this with a utility process;
 * web and mobile clients have none and therefore never host.
 */
export interface HostRelayAdapter {
  start(opts: RelayStartOptions): Promise<RelayHandle>;
}

/** Everything the client needs from the device it runs on. */
export interface PlatformAdapter {
  platform: Platform;
  appVersion: string;
  kv: KeyValueStore;
  messages: MessageStore;
  relay?: HostRelayAdapter;
  /** Browser WebRTC; absent means text/voice sessions are unavailable (e.g. unit tests). */
  rtc?: {
    RTCPeerConnection: typeof RTCPeerConnection;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  };
  /** Device capability hints for host election. */
  capabilities?: () => Promise<Partial<HostCaps>>;
  fetch?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.map.get(key)) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

export class MemoryMessageStore implements MessageStore {
  private byChannel = new Map<string, ChatMessage[]>();
  private ids = new Set<string>();

  async put(message: ChatMessage) {
    if (this.ids.has(message.id)) return false;
    this.ids.add(message.id);
    const list = this.byChannel.get(message.ch) ?? [];
    list.push(message);
    list.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    this.byChannel.set(message.ch, list);
    return true;
  }

  async page(channel: string, opts: { before?: number; limit: number }) {
    const list = (this.byChannel.get(channel) ?? []).filter((m) => opts.before === undefined || m.ts < opts.before);
    return list.slice(-opts.limit);
  }

  async since(channel: string, after: number, limit: number) {
    return (this.byChannel.get(channel) ?? []).filter((m) => m.ts > after).slice(0, limit);
  }

  async latestTs(channel: string) {
    return this.byChannel.get(channel)?.at(-1)?.ts ?? 0;
  }
}
