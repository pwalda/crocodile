import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/**
 * Every request from the UI goes through `handle`. Until the main process
 * says who may ask (`allowAsking`) nobody is served, so a handler added
 * without thought is closed rather than open. Electron's `ipcMain` is handed
 * in (`useIpc`) so this file is plain code that tests can drive.
 */
let ipc: Pick<IpcMain, 'handle'> | undefined;
let may: (e: IpcMainInvokeEvent) => boolean = () => false;

export function useIpc(ipcMain: Pick<IpcMain, 'handle'>) {
  ipc = ipcMain;
}

export function allowAsking(check: (e: IpcMainInvokeEvent) => boolean) {
  may = check;
}

export function handle(
  channel: string,
  // `never[]` lets each handler declare the arguments it expects.
  listener: (e: IpcMainInvokeEvent, ...args: never[]) => unknown,
) {
  if (!ipc) throw new Error('useIpc comes first');
  ipc.handle(channel, (e, ...args) => {
    if (!may(e)) throw new Error(`${channel}: not allowed from this page`);
    return listener(e, ...(args as never[]));
  });
}
