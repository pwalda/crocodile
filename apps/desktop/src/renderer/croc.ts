import { useRef, useSyncExternalStore } from 'react';
import { CrocodileClient, VoiceEngine, defaultVoiceSettings, type ClientState, type VoiceSettings } from '@crocodile/client-core';
import { StateStore } from '@crocodile/client-core';
import { createPlatform, desktop, kv } from './platform';
import FrameWorker from '@crocodile/client-core/frame-worker?worker';

export type View =
  | { kind: 'friends' }
  | { kind: 'dm'; userId: string }
  | { kind: 'space'; spaceId: string; channelId: string | null };

export type ModalState =
  | { kind: 'add-space' }
  | { kind: 'invite'; spaceId: string }
  | { kind: 'create-channel'; spaceId: string }
  | { kind: 'space-settings'; spaceId: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'profile'; userId: string }
  | { kind: 'new-dm' }
  | { kind: 'confirm'; title: string; body: string; action: string; danger?: boolean; onConfirm: () => void | Promise<void> };

export interface UiState {
  view: View;
  modal: ModalState | null;
  showMembers: boolean;
  voiceSettings: VoiceSettings;
  pttKey: string;
  micLevel: number;
  appVersion: string;
}

export const ui = new StateStore<UiState>({
  view: { kind: 'friends' },
  modal: null,
  showMembers: true,
  voiceSettings: defaultVoiceSettings,
  pttKey: 'Backquote',
  micLevel: -100,
  appVersion: '',
});

let client: CrocodileClient;

export async function bootClient(): Promise<CrocodileClient> {
  const info = (await desktop?.app.info()) ?? { version: '0.1.0-web', platform: 'web', directories: [], cpuCores: navigator.hardwareConcurrency };
  const builtIn = (process.env.CROC_DIRECTORIES as string | undefined)?.split(',').filter(Boolean) ?? [];
  const directories = info.directories.length ? info.directories : builtIn;
  const platform = createPlatform({ version: info.version, cpuCores: info.cpuCores, stun: () => client?.stunUrls ?? [] });

  // A locally running coordination server (if the user enabled one) is preferred.
  const local = await desktop?.coordinator.get();
  const preferred = local?.settings.enabled ? [`http://127.0.0.1:${local.settings.port}`] : [];

  client = new CrocodileClient(platform, {
    directories,
    preferredServers: preferred,
    log: (m, e) => console.debug(`[croc] ${m}`, e ?? ''),
  });

  const saved = (await kv.get<Partial<VoiceSettings>>('voice-settings')) ?? {};
  const pttKey = (await kv.get<string>('ptt-key')) ?? 'Backquote';
  const voiceSettings = { ...defaultVoiceSettings, ...saved };
  const engine = new VoiceEngine(
    {
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      createFrameWorker: () => new FrameWorker(),
    },
    voiceSettings,
  );
  engine.on('level', ({ db }) => ui.set({ micLevel: db }));
  engine.on('error', ({ message }) => client.reportError(message));
  engine.on('track', (track) => {
    const id = client.state.voiceSession;
    if (id) void client.sessionFor(id)?.setMicTrack(track);
  });
  client.voiceEngine = engine;
  ui.set({ voiceSettings, pttKey, appVersion: info.version });
  await client.init();
  return client;
}

export function getClient() {
  return client;
}

export async function saveVoiceSettings(patch: Partial<VoiceSettings>) {
  const engine = client.voiceEngine!;
  await engine.updateSettings(patch);
  ui.set({ voiceSettings: engine.settings });
  await kv.set('voice-settings', engine.settings);
}

function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function useStore<S extends object, T>(store: StateStore<S>, selector: (s: S) => T): T {
  const cache = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(store.subscribe, () => {
    const next = selector(store.get());
    if (cache.current && shallowEqual(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  });
}

/** Subscribe to a slice of client state; re-renders only when it changes (shallowly). */
export function useCroc<T>(selector: (s: ClientState) => T): T {
  return useStore(client.store, selector);
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(ui, selector);
}

export const openModal = (modal: ModalState) => ui.set({ modal });
export const closeModal = () => ui.set({ modal: null });

export function navigate(view: View) {
  ui.set({ view });
  if (view.kind === 'space' && view.channelId) void client.openChannel(view.channelId);
  else if (view.kind === 'dm') void client.openDm(view.userId).then((ch) => client.openChannel(ch));
  else client.closeChannel();
}
