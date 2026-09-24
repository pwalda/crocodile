import { app, systemPreferences, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * System-wide push-to-talk: a native keyboard/mouse hook (libuiohook) so the
 * key works while another app (a game) has focus. Loaded from dist/native so
 * the bundler never touches the .node binary. If the hook cannot start
 * (e.g. Wayland, missing macOS permission) the renderer's in-window
 * push-to-talk still works.
 */
type Hook = {
  uIOhook: {
    on(ev: 'keydown' | 'keyup', fn: (e: { keycode: number }) => void): void;
    on(ev: 'mousedown' | 'mouseup', fn: (e: { button: unknown }) => void): void;
    removeAllListeners(): void;
    start(): void;
    stop(): void;
  };
  UiohookKey: Record<string, number>;
};

let hook: Hook | null | undefined;
let running = false;
let target: { kind: 'key'; keycode: number } | { kind: 'mouse'; button: number } | null = null;
let pressed = false;
let sink: WebContents | null = null;

function loadHook(): Hook | null {
  if (hook !== undefined) return hook;
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'native', 'uiohook-napi')
    : join(__dirname, '..', 'native', 'uiohook-napi');
  try {
    hook = existsSync(dir) ? (require(dir) as Hook) : null;
  } catch (err) {
    console.warn('global push-to-talk unavailable', err);
    hook = null;
  }
  return hook;
}

/** Translate a DOM `KeyboardEvent.code` (or Mouse4/Mouse5) to a hook target. */
function toTarget(code: string, keys: Record<string, number>): typeof target {
  const mouse = code.match(/^Mouse(\d)$/);
  if (mouse) return { kind: 'mouse', button: Number(mouse[1]) };
  const aliases: Record<string, string> = {
    ControlLeft: 'Ctrl',
    ControlRight: 'CtrlRight',
    AltLeft: 'Alt',
    AltRight: 'AltRight',
    ShiftLeft: 'Shift',
    ShiftRight: 'ShiftRight',
    MetaLeft: 'Meta',
    MetaRight: 'MetaRight',
  };
  const name = aliases[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '');
  const keycode = keys[name];
  return keycode === undefined ? null : { kind: 'key', keycode };
}

function emit(down: boolean) {
  if (pressed === down) return;
  pressed = down;
  sink?.send('ptt:state', down);
}

export type GlobalPttStatus = 'active' | 'unavailable' | 'needs-permission' | 'off';

export function configureGlobalPtt(contents: WebContents, code: string | null): GlobalPttStatus {
  sink = contents;
  const h = loadHook();
  if (!code) {
    if (running && h) {
      h.uIOhook.stop();
      h.uIOhook.removeAllListeners();
      running = false;
    }
    target = null;
    return 'off';
  }
  if (!h) return 'unavailable';
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
    return 'needs-permission';
  }
  target = toTarget(code, h.UiohookKey);
  if (!target) return 'unavailable';
  if (!running) {
    h.uIOhook.on(
      'keydown',
      (e) => target?.kind === 'key' && e.keycode === target.keycode && emit(true),
    );
    h.uIOhook.on(
      'keyup',
      (e) => target?.kind === 'key' && e.keycode === target.keycode && emit(false),
    );
    h.uIOhook.on(
      'mousedown',
      (e) => target?.kind === 'mouse' && e.button === target.button && emit(true),
    );
    h.uIOhook.on(
      'mouseup',
      (e) => target?.kind === 'mouse' && e.button === target.button && emit(false),
    );
    try {
      h.uIOhook.start();
      running = true;
    } catch (err) {
      console.warn('could not start keyboard hook', err);
      return 'unavailable';
    }
  }
  return 'active';
}

export function stopGlobalPtt() {
  if (running) hook?.uIOhook.stop();
  running = false;
}
