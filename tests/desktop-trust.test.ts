import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { allowAsking, handle, useIpc } from '../apps/desktop/src/main/ipc-guard';
import {
  honoursTestSettings,
  mayAsk,
  openingSwitch,
  scriptEnvironment,
  type Pages,
} from '../apps/desktop/src/main/trust';
import { refuseStrayDrops, type DropEvent } from '../apps/desktop/src/renderer/lib/drops';

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
useIpc({ handle: (channel, fn) => void handlers.set(channel, fn as never) });

const pages: Pages = {
  appUrl: 'file:///opt/Crocodile/resources/app.asar/dist/renderer/index.html',
};
const asker = { fromWindow: true, topFrame: true, url: `${pages.appUrl}#/chat` };

describe('who may ask the main process', () => {
  it('serves the app page in the app window', () => {
    expect(mayAsk(asker, pages)).toBe(true);
  });

  it('refuses a dropped or downloaded file shown in the window', () => {
    expect(mayAsk({ ...asker, url: 'file:///home/me/Downloads/x.html' }, pages)).toBe(false);
  });

  it('refuses a frame inside the page, other windows, and a frame that is already gone', () => {
    expect(mayAsk({ ...asker, topFrame: false }, pages)).toBe(false);
    expect(mayAsk({ ...asker, fromWindow: false }, pages)).toBe(false);
    expect(mayAsk({ ...asker, url: undefined }, pages)).toBe(false);
    expect(mayAsk({ ...asker, url: null }, pages)).toBe(false);
  });

  it('takes the development server only when one is set', () => {
    const dev = { ...pages, devUrl: 'http://localhost:5173' };
    expect(mayAsk({ ...asker, url: 'http://localhost:5173/' }, dev)).toBe(true);
    expect(mayAsk({ ...asker, url: 'http://localhost:5173/' }, pages)).toBe(false);
    expect(mayAsk({ ...asker, url: 'http://localhost:5173.evil.test/' }, dev)).toBe(false);
  });
});

describe('requests from the UI', () => {
  beforeEach(() => {
    handlers.clear();
    allowAsking(() => false);
  });

  it('are refused until the window says who may ask', async () => {
    handle('secure:get', () => 'the seed');
    expect(() => handlers.get('secure:get')!({})).toThrow(/not allowed/);
  });

  it('are refused for a page that may not ask, and served for the app', async () => {
    const seen: unknown[] = [];
    handle('files:read', (_e, id: string, index: number) => (seen.push(id, index), 'block'));
    allowAsking((e) => (e as unknown as { ok: boolean }).ok);
    expect(() => handlers.get('files:read')!({ ok: false }, 'a', 1)).toThrow(/not allowed/);
    expect(seen).toEqual([]);
    expect(handlers.get('files:read')!({ ok: true }, 'a', 1)).toBe('block');
    expect(seen).toEqual(['a', 1]);
  });

  it('are all registered through the guard', () => {
    const dir = join(__dirname, '../apps/desktop/src/main');
    const bypass = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'ipc-guard.ts')
      .filter((f) =>
        /ipcMain\.(handle|handleOnce|on|once)\(/.test(readFileSync(join(dir, f), 'utf8')),
      );
    expect(bypass).toEqual([]);
  });
});

describe('test settings', () => {
  it('are off in a release and on in development or in a build made for the end-to-end test', () => {
    expect(honoursTestSettings(true, {})).toBe(false);
    expect(honoursTestSettings(true, { crocTestBuild: 'yes' })).toBe(false);
    expect(honoursTestSettings(true, { crocTestBuild: true })).toBe(true);
    expect(honoursTestSettings(false, {})).toBe(true);
  });
});

describe('a release', () => {
  it('refuses to start with a debugging port, pipe or inspector', () => {
    for (const a of [
      '--remote-debugging-port=9222',
      '--remote-debugging-pipe',
      '--inspect=0',
      '--inspect-brk',
      '--remote-allow-origins=*',
    ])
      expect(openingSwitch(['crocodile', '--foo', a])).toBe(a);
    expect(openingSwitch(['crocodile', '--no-sandbox', 'croc://join/abc'])).toBeUndefined();
  });

  it('passes no relaunch command to the update script', () => {
    const env = { PATH: '/bin', CROC_RELAUNCH: '/tmp/payload' };
    expect(scriptEnvironment(env, false)).toEqual({ PATH: '/bin' });
    expect(scriptEnvironment(env, true)).toEqual(env);
    expect(scriptEnvironment({ PATH: '/bin' }, true)).toEqual({ PATH: '/bin' });
  });
});

describe('Electron fuses', () => {
  const load = (testBuild: boolean) => {
    const was = process.env.CROC_TEST_BUILD;
    process.env.CROC_TEST_BUILD = testBuild ? '1' : '';
    const path = join(__dirname, '../apps/desktop/electron-builder.config.cjs');
    const require = createRequire(import.meta.url);
    delete require.cache[path];
    try {
      return require(path) as {
        electronFuses: Record<string, boolean>;
        extraMetadata: Record<string, unknown>;
      };
    } finally {
      if (was === undefined) delete process.env.CROC_TEST_BUILD;
      else process.env.CROC_TEST_BUILD = was;
      delete require.cache[path];
    }
  };

  it('a release cannot be run as Node.js, through NODE_OPTIONS or a debugging port', () => {
    const { electronFuses, extraMetadata } = load(false);
    expect(electronFuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
    });
    expect(extraMetadata.crocTestBuild).toBeUndefined();
  });

  it('only the end-to-end test build keeps the debugging port and honours test settings', () => {
    const { electronFuses, extraMetadata } = load(true);
    expect(electronFuses.enableNodeCliInspectArguments).toBe(true);
    expect(electronFuses.runAsNode).toBe(false);
    expect(extraMetadata.crocTestBuild).toBe(true);
  });
});

describe('files dropped on the window', () => {
  function drop() {
    const listeners: Record<string, (e: DropEvent) => void> = {};
    refuseStrayDrops({ addEventListener: (type, fn) => void (listeners[type] = fn) });
    const event = (handled = false, withFiles = true): DropEvent & { prevented: boolean } => {
      const e = {
        prevented: handled,
        get defaultPrevented() {
          return this.prevented;
        },
        dataTransfer: { dropEffect: 'copy', types: withFiles ? ['Files'] : ['text/plain'] },
        preventDefault() {
          this.prevented = true;
        },
      };
      return e;
    };
    return { listeners, event };
  }

  it('do nothing when nobody takes them (they would open as a page)', () => {
    const { listeners, event } = drop();
    const over = event();
    listeners.dragover!(over);
    expect(over.prevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('none');
    const dropped = event();
    listeners.drop!(dropped);
    expect(dropped.prevented).toBe(true);
  });

  it('leave text dragged in or within a field alone', () => {
    const { listeners, event } = drop();
    const over = event(false, false);
    listeners.dragover!(over);
    expect(over.prevented).toBe(false);
    expect(over.dataTransfer!.dropEffect).toBe('copy');
    const dropped = event(false, false);
    listeners.drop!(dropped);
    expect(dropped.prevented).toBe(false);
  });

  it('are left to a place that takes them', () => {
    const { listeners, event } = drop();
    const over = event(true);
    listeners.dragover!(over);
    expect(over.dataTransfer!.dropEffect).toBe('copy');
  });
});
