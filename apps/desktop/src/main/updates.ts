/**
 * Updates from within the app. The app checks for a new release now and then
 * and says so; the user decides when to download it and when to restart.
 *
 * How an update is applied depends on how the app was installed (updateMode):
 * - 'auto': electron-updater does it (Windows, Linux AppImage/deb/rpm, and
 *   macOS builds signed with a Developer ID).
 * - 'mac-swap': unsigned macOS builds, which Squirrel.Mac refuses to update.
 *   We download the zip ourselves, check its hash, and after the app quits a
 *   small script swaps the new bundle in and starts it. If the app's folder
 *   isn't writable, the .dmg is downloaded and opened instead.
 * - 'manual': installs nothing can update in place (a tar.gz); the download
 *   page opens.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { UpdateStatus } from './ipc-types';

export type UpdateMode = 'auto' | 'mac-swap' | 'manual';

/** How this install can update, or null when it can't check at all (development builds). */
export function updateMode(env: {
  packaged: boolean;
  platform: NodeJS.Platform;
  /** macOS: signed with a Developer ID, so Squirrel.Mac accepts updates. */
  developerSigned: boolean;
  /** Linux: running as an AppImage ($APPIMAGE). */
  appImage: boolean;
  /** Linux: resources/package-type, written for .deb and .rpm installs. */
  packageType: string | null;
}): UpdateMode | null {
  if (!env.packaged) return null;
  if (env.platform === 'win32') return 'auto';
  if (env.platform === 'darwin') return env.developerSigned ? 'auto' : 'mac-swap';
  if (env.platform === 'linux') {
    if (env.appImage) return 'auto';
    if (env.packageType === 'deb' || env.packageType === 'rpm') return 'auto';
    return 'manual';
  }
  return 'manual';
}

/** True if version `a` is newer than `b` (both like 1.2.3). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export interface ReleaseFile {
  url: string;
  sha512: string;
  size: number;
}

/**
 * The parts of a release's latest*.yml (written by electron-builder) we use:
 * the version and its files. Only this file's simple layout is understood.
 */
export function parseLatestYml(text: string): { version: string; files: ReleaseFile[] } | null {
  const version = /^version:\s*['"]?([0-9][^'"\s]*)/m.exec(text)?.[1];
  if (!version) return null;
  const files: ReleaseFile[] = [];
  let current: Partial<ReleaseFile> | null = null;
  const finish = () => {
    if (current?.url && current.sha512 && current.size) files.push(current as ReleaseFile);
    current = null;
  };
  let inFiles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles && /^\S/.test(line)) {
      finish();
      inFiles = false;
    }
    if (!inFiles) continue;
    const m = /^\s*(-\s+)?(url|sha512|size):\s*['"]?([^'"]*?)['"]?\s*$/.exec(line);
    if (!m) continue;
    if (m[1]) finish();
    current ??= {};
    if (m[2] === 'size') current.size = Number(m[3]);
    else current[m[2] as 'url' | 'sha512'] = m[3];
  }
  finish();
  return { version, files };
}

/**
 * Downloads `url` to `dest`, failing (and removing the file) unless its
 * SHA-512 matches the release metadata's.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expected: { sha512: string; size: number },
  onProgress: (percent: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const hash = createHash('sha512');
  const out = createWriteStream(dest);
  // A failed write (a full disk) rejects the next wait instead of throwing.
  const failed = new Promise<never>((_, reject) => out.once('error', reject));
  failed.catch(() => {});
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await Promise.race([once(out, 'drain'), failed]);
      onProgress(Math.min(100, Math.floor((received / expected.size) * 100)));
    }
    out.end();
    await Promise.race([finished(out), failed]);
    if (hash.digest('base64') !== expected.sha512)
      throw new Error('the download does not match the release (checksum mismatch)');
  } catch (err) {
    out.destroy();
    await rm(dest, { force: true });
    throw err;
  }
}

/**
 * The script that swaps in an unsigned macOS update: it waits for the app
 * (pid $1) to quit, moves the new bundle ($3) in place of the old one ($2),
 * putting the old one back if that fails, and starts the result.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
pid="$1"; current="$2"; next="$3"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$current.old-$$"
if mv "$current" "$old"; then
  if mv "$next" "$current"; then rm -rf "$old"; else mv "$old" "$current"; fi
fi
xattr -dr com.apple.quarantine "$current" 2>/dev/null || true
\${CROC_RELAUNCH:-open} "$current"
`;

/** Something that can find, fetch and apply a newer release. */
export interface UpdateEngine {
  /** The newer release, or null when this one is current. */
  check(): Promise<{ version: string } | null>;
  /** Fetches the release found by check(). */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Applies it: quits and restarts, or opens the installer ('open'). */
  install(): void;
  /** What the user does after the download: restart, or run the installer we open. */
  readonly after: 'restart' | 'open';
  /** 'download': the update can't be applied here; the download page opens instead. */
  readonly how: 'install' | 'download';
}

/** The parts of electron-updater's autoUpdater we use. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{
    isUpdateAvailable: boolean;
    updateInfo: { version: string };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  /** Quits the app once the installer has started; leaves it running if that fails. */
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', fn: (p: { percent: number }) => void): unknown;
  off(event: 'download-progress', fn: (p: { percent: number }) => void): unknown;
}

/**
 * electron-updater: Windows, Linux AppImage/deb/rpm and Developer ID-signed
 * macOS. Nothing downloads until asked. Installing doesn't mark the app as
 * quitting itself: if the installer can't start (the administrator password
 * prompt was cancelled), the app keeps running as before.
 */
export function electronUpdaterEngine(updater: AutoUpdaterLike): UpdateEngine {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  return {
    how: 'install',
    after: 'restart',
    async check() {
      const result = await updater.checkForUpdates();
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null;
    },
    async download(onProgress) {
      const listener = (p: { percent: number }) => onProgress(Math.floor(p.percent));
      updater.on('download-progress', listener);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.off('download-progress', listener);
      }
    },
    install() {
      updater.quitAndInstall(true, true);
    },
  };
}

/** Drives an UpdateEngine and reports its state (shown in the app). */
export class UpdateController {
  private current: UpdateStatus;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly engine: UpdateEngine | null,
    private readonly publish: (s: UpdateStatus) => void,
  ) {
    this.current = engine ? { state: 'idle' } : { state: 'unsupported' };
  }

  get status(): UpdateStatus {
    return this.current;
  }

  private set(s: UpdateStatus) {
    this.current = s;
    this.publish(s);
  }

  /** Looks for a newer release; never downloads (the user decides). */
  async check(): Promise<UpdateStatus> {
    const { engine } = this;
    const busy = ['checking', 'downloading', 'ready'].includes(this.current.state);
    if (!engine || busy || this.checking) return this.current;
    // A release already offered stays on screen while we look again.
    if (this.current.state !== 'available') this.set({ state: 'checking' });
    const started = this.current;
    this.checking = (async () => {
      let next: UpdateStatus;
      try {
        const found = await engine.check();
        next = found
          ? { state: 'available', version: found.version, how: engine.how }
          : { state: 'current', checkedAt: Date.now() };
      } catch (err) {
        next = { state: 'error', message: messageOf(err) };
      }
      if (this.current === started) this.set(next);
    })();
    try {
      await this.checking;
    } finally {
      this.checking = null;
    }
    return this.current;
  }

  /** Downloads the release found, then waits for the user to restart. */
  async download(): Promise<UpdateStatus> {
    const { engine } = this;
    // One thing at a time: a check started in the background finishes first.
    if (this.checking) await this.checking;
    const s = this.current;
    if (!engine || s.state !== 'available') return this.current;
    if (engine.how === 'download') {
      engine.install();
      return this.current;
    }
    const version = s.version;
    this.set({ state: 'downloading', version, percent: 0 });
    try {
      let last = 0;
      await engine.download((percent) => {
        if (percent === last) return;
        last = percent;
        this.set({ state: 'downloading', version, percent });
      });
      this.set({ state: 'ready', version, after: engine.after });
    } catch (err) {
      this.set({ state: 'error', message: messageOf(err), version });
    }
    return this.current;
  }

  /** Restarts into the downloaded version (or opens its installer). */
  install() {
    if (this.engine && this.current.state === 'ready') this.engine.install();
  }
}

/** Where release files are: `${RELEASE_FEED}/latest-mac.yml` and so on. */
export const RELEASE_FEED = 'https://github.com/pwalda/crocodile/releases/latest/download';
export const RELEASES_URL = 'https://github.com/pwalda/crocodile/releases/latest';

/** The latest release described by `feed/name` (a latest*.yml). */
export async function latestRelease(feed: string, name: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(`${feed}/${name}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`could not reach the release server (HTTP ${res.status})`);
  const release = parseLatestYml(await res.text());
  if (!release) throw new Error('the release information is unreadable');
  return release;
}

/**
 * For installs that can't be updated in place (a tar.gz): says when there's
 * a new release and opens its download page.
 */
export class ManualEngine implements UpdateEngine {
  readonly how = 'download';
  readonly after = 'open';

  constructor(
    private readonly deps: {
      currentVersion: string;
      feed: string;
      yml: string;
      fetch?: typeof fetch;
      openExternal: (url: string) => void;
    },
  ) {}

  async check() {
    const { version } = await latestRelease(this.deps.feed, this.deps.yml, this.deps.fetch);
    return isNewer(version, this.deps.currentVersion) ? { version } : null;
  }

  async download() {}

  install() {
    this.deps.openExternal(RELEASES_URL);
  }
}

export interface MacSwapDeps {
  currentVersion: string;
  feed: string;
  /** The running app: /Applications/Crocodile.app. */
  bundlePath: string;
  /** Scratch space for the download (emptied first). */
  workDir: string;
  /** Where the .dmg goes when the app can't replace itself. */
  downloadsDir: string;
  /** False when the app's folder can't be written (translocated, on a disk image, permissions). */
  canReplace: boolean;
  fetch?: typeof fetch;
  /** Unpacks a zip (ditto -x -k). */
  unzip: (zip: string, into: string) => Promise<void>;
  /** CFBundleShortVersionString of an .app. */
  bundleVersion: (app: string) => Promise<string>;
  /** Runs the swap script detached, so it outlives the app. */
  runDetached: (script: string, args: string[]) => void;
  openPath: (path: string) => void;
  /** Quits the app (the swap script restarts it). */
  quit: () => void;
  pid: number;
}

/**
 * Updates an unsigned macOS app in place, as Squirrel.Mac would for a signed
 * one: downloads the release zip, checks its hash and version, and swaps the
 * bundle once the app has quit (MAC_SWAP_SCRIPT). Where the app can't replace
 * itself, downloads the .dmg and opens it instead.
 */
export class MacSwapEngine implements UpdateEngine {
  readonly how = 'install';
  readonly after: 'restart' | 'open';
  private found: { version: string; files: ReleaseFile[] } | null = null;
  private staged: string | null = null;

  constructor(private readonly deps: MacSwapDeps) {
    this.after = deps.canReplace ? 'restart' : 'open';
  }

  async check() {
    const release = await latestRelease(this.deps.feed, 'latest-mac.yml', this.deps.fetch);
    this.found = isNewer(release.version, this.deps.currentVersion) ? release : null;
    return this.found && { version: this.found.version };
  }

  async download(onProgress: (percent: number) => void) {
    const release = this.found;
    if (!release) throw new Error('no update to download');
    const ext = this.after === 'restart' ? '.zip' : '.dmg';
    const file = release.files.find((f) => f.url.endsWith(ext));
    if (!file || /[/\\]/.test(file.url)) throw new Error(`the release has no ${ext} for macOS`);
    const url = `${this.deps.feed}/${encodeURIComponent(file.url)}`;
    if (ext === '.dmg') {
      const dest = join(this.deps.downloadsDir, file.url);
      await downloadVerified(url, dest, file, onProgress, this.deps.fetch);
      this.staged = dest;
      return;
    }
    const { workDir } = this.deps;
    await rm(workDir, { recursive: true, force: true });
    await mkdir(join(workDir, 'app'), { recursive: true });
    const zip = join(workDir, 'update.zip');
    await downloadVerified(url, zip, file, onProgress, this.deps.fetch);
    await this.deps.unzip(zip, join(workDir, 'app'));
    await rm(zip, { force: true });
    const name = (await readdir(join(workDir, 'app'))).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('the update has no app in it');
    const app = join(workDir, 'app', name);
    const version = await this.deps.bundleVersion(app);
    if (version !== release.version)
      throw new Error(`the update is version ${version}, not ${release.version}`);
    await writeFile(join(workDir, 'swap.sh'), MAC_SWAP_SCRIPT, { mode: 0o755 });
    this.staged = app;
  }

  install() {
    const { staged } = this;
    if (!staged) return;
    if (this.after === 'open') {
      // The user drags the new version over this one, which must have quit.
      this.deps.openPath(staged);
    } else {
      const script = join(this.deps.workDir, 'swap.sh');
      this.deps.runDetached(script, [String(this.deps.pid), this.deps.bundlePath, staged]);
    }
    this.deps.quit();
  }
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0]!.slice(0, 200);
}
