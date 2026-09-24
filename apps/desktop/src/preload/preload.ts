import { contextBridge, ipcRenderer } from 'electron';
import type { CoordinatorSettings, CoordinatorStatus, RelayProcessIn, RelayProcessOut } from '../main/ipc-types';

/** The only bridge between the sandboxed UI and the rest of the app. */
const api = {
  secure: {
    get: (key: string) => ipcRenderer.invoke('secure:get', key) as Promise<string | undefined>,
    set: (key: string, value: string) => ipcRenderer.invoke('secure:set', key, value) as Promise<void>,
    delete: (key: string) => ipcRenderer.invoke('secure:delete', key) as Promise<void>,
  },
  relay: {
    send: (msg: RelayProcessIn) => ipcRenderer.invoke('relay:send', msg) as Promise<void>,
    onEvent: (fn: (msg: RelayProcessOut) => void) => {
      const listener = (_e: unknown, msg: RelayProcessOut) => fn(msg);
      ipcRenderer.on('relay:event', listener);
      return () => {
        ipcRenderer.off('relay:event', listener);
      };
    },
  },
  coordinator: {
    get: () => ipcRenderer.invoke('coordinator:get') as Promise<{ settings: CoordinatorSettings; status: CoordinatorStatus }>,
    set: (patch: Partial<CoordinatorSettings>) => ipcRenderer.invoke('coordinator:set', patch) as Promise<CoordinatorSettings>,
    onStatus: (fn: (s: CoordinatorStatus) => void) => {
      const listener = (_e: unknown, s: CoordinatorStatus) => fn(s);
      ipcRenderer.on('coordinator:status', listener);
      return () => {
        ipcRenderer.off('coordinator:status', listener);
      };
    },
  },
  app: {
    info: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string; directories: string[]; cpuCores: number }>,
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
    setBadge: (count: number) => ipcRenderer.invoke('app:badge', count) as Promise<void>,
    takeDeepLink: () => ipcRenderer.invoke('app:take-deeplink') as Promise<string | null>,
    onDeepLink: (fn: (url: string) => void) => {
      const listener = (_e: unknown, url: string) => fn(url);
      ipcRenderer.on('app:deeplink', listener);
      return () => {
        ipcRenderer.off('app:deeplink', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('crocodile', api);
export type DesktopApi = typeof api;
