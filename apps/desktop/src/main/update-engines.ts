/** Picks how this install updates itself (see updates.ts) and wires it to Electron. */
import { app, net, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  MacSwapEngine,
  ManualEngine,
  RELEASE_FEED,
  updateMode,
  type UpdateEngine,
} from './updates';

const run = promisify(execFile);

/**
 * The engine for this install, or null for a development build.
 * `beforeQuit` runs before the app quits to install.
 */
export async function createUpdateEngine(beforeQuit: () => void): Promise<UpdateEngine | null> {
  const fake = process.env.CROC_FAKE_UPDATE;
  if (fake) return fakeEngine(fake);
  const mode = updateMode({
    packaged: app.isPackaged,
    platform: process.platform,
    developerSigned: developerSigned(),
    appImage: !!process.env.APPIMAGE,
    packageType: packageType(),
  });
  if (mode === 'auto') return electronUpdater(beforeQuit);
  const fetchImpl = (url: string | URL | Request, init?: RequestInit) =>
    net.fetch(url instanceof URL ? url.href : url, init);
  if (mode === 'mac-swap') {
    // process.execPath is …/Crocodile.app/Contents/MacOS/Crocodile.
    const bundlePath = resolve(process.execPath, '../../..');
    return new MacSwapEngine({
      currentVersion: app.getVersion(),
      feed: RELEASE_FEED,
      bundlePath,
      workDir: join(app.getPath('userData'), 'update'),
      downloadsDir: app.getPath('downloads'),
      canReplace: canReplace(bundlePath),
      fetch: fetchImpl,
      unzip: async (zip, into) => void (await run('/usr/bin/ditto', ['-x', '-k', zip, into])),
      bundleVersion: async (bundle) =>
        (
          await run('/usr/bin/plutil', [
            '-extract',
            'CFBundleShortVersionString',
            'raw',
            '-o',
            '-',
            join(bundle, 'Contents/Info.plist'),
          ])
        ).stdout.trim(),
      runDetached: (script, args) =>
        spawn('/bin/sh', [script, ...args], { detached: true, stdio: 'ignore' }).unref(),
      openPath: (p) => void shell.openPath(p),
      quit: () => {
        beforeQuit();
        app.quit();
      },
      pid: process.pid,
    });
  }
  if (mode === 'manual')
    return new ManualEngine({
      currentVersion: app.getVersion(),
      feed: RELEASE_FEED,
      yml: process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml',
      fetch: fetchImpl,
      openExternal: (url) => void shell.openExternal(url),
    });
  return null;
}

/** electron-updater: Windows, Linux AppImage/deb/rpm and Developer ID-signed macOS. */
async function electronUpdater(beforeQuit: () => void): Promise<UpdateEngine> {
  const { autoUpdater } = await import('electron-updater');
  // Ask first: nothing downloads until the user says so.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  return {
    how: 'install',
    after: 'restart',
    async check() {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null;
    },
    async download(onProgress) {
      const listener = (p: { percent: number }) => onProgress(Math.floor(p.percent));
      autoUpdater.on('download-progress', listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off('download-progress', listener);
      }
    },
    install() {
      beforeQuit();
      autoUpdater.quitAndInstall(true, true);
    },
  };
}

/**
 * CROC_FAKE_UPDATE=<version> pretends that version is out, for the smoke test
 * and for trying the UI: the download takes a few seconds, and installing
 * only logs.
 */
function fakeEngine(version: string): UpdateEngine {
  return {
    how: 'install',
    after: 'restart',
    check: async () => ({ version }),
    async download(onProgress) {
      for (let p = 0; p <= 100; p += 10) {
        onProgress(p);
        await new Promise((r) =>
          setTimeout(r, Number(process.env.CROC_FAKE_UPDATE_STEP_MS ?? 300)),
        );
      }
    },
    install() {
      console.log(`[updates] would restart into ${version}`);
    },
  };
}

/** Set at build time when the macOS build has a Developer ID signature. */
function developerSigned(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
    return pkg.crocSigned === true;
  } catch {
    return false;
  }
}

/** 'deb' or 'rpm' for those installs (electron-builder writes the file). */
function packageType(): string | null {
  const file = join(process.resourcesPath, 'package-type');
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Whether the app can replace its own bundle: not run from a disk image or
 * from macOS's read-only translocation, and its folder writable by this user.
 */
function canReplace(bundlePath: string): boolean {
  if (!bundlePath.endsWith('.app')) return false;
  if (bundlePath.startsWith('/Volumes/') || bundlePath.includes('/AppTranslocation/')) return false;
  try {
    accessSync(dirname(bundlePath), constants.W_OK);
    accessSync(bundlePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
