import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAC_SWAP_SCRIPT,
  MacSwapEngine,
  ManualEngine,
  UpdateController,
  downloadVerified,
  isNewer,
  parseLatestYml,
  updateMode,
  type MacSwapDeps,
  type UpdateEngine,
} from '../src/main/updates';
import type { UpdateStatus } from '../src/main/ipc-types';

// As published with beta-v0.3.1.
const LATEST_MAC = `version: 0.3.1
files:
  - url: Crocodile-0.3.1-mac-universal.zip
    sha512: gCEMRPU9An1hayq9Jt5EDt+pQbSXK157Pp2W1RzBvndM2/lqUVubFrLY/zudepyBTHccogxuHwLU0Q6PHwmu/g==
    size: 229311292
  - url: Crocodile-0.3.1-mac-universal.dmg
    sha512: qdnjo3K6Dru1JoDQRv2pWLRGy2jDaQP8brg1o/iL5DymVBlLCXvyJyLacqHBlwKGlZxkNqi8+YuQX4FelFVeXQ==
    size: 229580355
path: Crocodile-0.3.1-mac-universal.zip
sha512: gCEMRPU9An1hayq9Jt5EDt+pQbSXK157Pp2W1RzBvndM2/lqUVubFrLY/zudepyBTHccogxuHwLU0Q6PHwmu/g==
releaseDate: '2026-10-09T15:59:50.834Z'
`;
const LATEST_LINUX = `version: 0.3.1
files:
  - url: Crocodile-0.3.1-linux-x86_64.AppImage
    sha512: YJstTpFiSZ8dNiS6bjJrgxqq4QthTs6XEDRxmFhtnZMtCEeTJPcgVY7JDJBKt4rquGg3ppTFzp5Y1UrRb7995w==
    size: 126417009
    blockMapSize: 133253
  - url: Crocodile-0.3.1-linux-amd64.deb
    sha512: kB7e93lKW/ZSaQW7Id1ZsNVBO+0viRYEwCfgT9sFaDj4BhPFdFWHjVIKAokTj2Fk/suvVJfjhTtEl/2OSoMYpw==
    size: 100327052
path: Crocodile-0.3.1-linux-x86_64.AppImage
sha512: YJstTpFiSZ8dNiS6bjJrgxqq4QthTs6XEDRxmFhtnZMtCEeTJPcgVY7JDJBKt4rquGg3ppTFzp5Y1UrRb7995w==
releaseDate: '2026-10-09T16:01:08.473Z'
`;

const sha512 = (data: Buffer | string) => createHash('sha512').update(data).digest('base64');

/** Serves `files` over HTTP on localhost; returns its base URL. */
async function serve(files: Record<string, Buffer | string>) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const body = files[name];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe('update mode', () => {
  const base = {
    packaged: true,
    developerSigned: false,
    appImage: false,
    packageType: null,
  };
  it('picks how each kind of install updates', () => {
    expect(updateMode({ ...base, packaged: false, platform: 'win32' })).toBeNull();
    expect(updateMode({ ...base, platform: 'win32' })).toBe('auto');
    expect(updateMode({ ...base, platform: 'darwin' })).toBe('mac-swap');
    expect(updateMode({ ...base, platform: 'darwin', developerSigned: true })).toBe('auto');
    expect(updateMode({ ...base, platform: 'linux', appImage: true })).toBe('auto');
    expect(updateMode({ ...base, platform: 'linux', packageType: 'deb' })).toBe('auto');
    expect(updateMode({ ...base, platform: 'linux', packageType: 'rpm' })).toBe('auto');
    expect(updateMode({ ...base, platform: 'linux' })).toBe('manual');
  });
});

describe('release metadata', () => {
  it('reads the version and files of a real latest-mac.yml', () => {
    const release = parseLatestYml(LATEST_MAC)!;
    expect(release.version).toBe('0.3.1');
    expect(release.files).toEqual([
      {
        url: 'Crocodile-0.3.1-mac-universal.zip',
        sha512:
          'gCEMRPU9An1hayq9Jt5EDt+pQbSXK157Pp2W1RzBvndM2/lqUVubFrLY/zudepyBTHccogxuHwLU0Q6PHwmu/g==',
        size: 229311292,
      },
      {
        url: 'Crocodile-0.3.1-mac-universal.dmg',
        sha512:
          'qdnjo3K6Dru1JoDQRv2pWLRGy2jDaQP8brg1o/iL5DymVBlLCXvyJyLacqHBlwKGlZxkNqi8+YuQX4FelFVeXQ==',
        size: 229580355,
      },
    ]);
  });

  it('ignores fields it does not use and the top-level path', () => {
    const release = parseLatestYml(LATEST_LINUX)!;
    expect(release.files.map((f) => f.url)).toEqual([
      'Crocodile-0.3.1-linux-x86_64.AppImage',
      'Crocodile-0.3.1-linux-amd64.deb',
    ]);
    expect(parseLatestYml('<html>Not Found</html>')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(isNewer('0.4.0', '0.3.1')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0', '0.99.99')).toBe(true);
    expect(isNewer('0.3.1', '0.3.1')).toBe(false);
    expect(isNewer('0.3.0', '0.3.1')).toBe(false);
  });
});

describe('verified download', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'croc-update-'));

  it('saves the file and reports progress', async () => {
    const body = Buffer.alloc(300_000, 7);
    const srv = await serve({ 'a.zip': body });
    const dest = join(dir(), 'a.zip');
    const seen: number[] = [];
    try {
      await downloadVerified(
        `${srv.url}/a.zip`,
        dest,
        { sha512: sha512(body), size: body.length },
        (p) => seen.push(p),
      );
    } finally {
      srv.close();
    }
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(seen.at(-1)).toBe(100);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('deletes a file that does not match the release', async () => {
    const srv = await serve({ 'a.zip': 'tampered' });
    const dest = join(dir(), 'a.zip');
    try {
      await expect(
        downloadVerified(
          `${srv.url}/a.zip`,
          dest,
          { sha512: sha512('original'), size: 8 },
          () => {},
        ),
      ).rejects.toThrow(/checksum/);
    } finally {
      srv.close();
    }
    expect(existsSync(dest)).toBe(false);
  });

  it('fails on an HTTP error', async () => {
    const srv = await serve({});
    try {
      await expect(
        downloadVerified(
          `${srv.url}/gone.zip`,
          join(dir(), 'x'),
          { sha512: '', size: 1 },
          () => {},
        ),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      srv.close();
    }
  });

  it('fails cleanly when the file cannot be written', async () => {
    const body = Buffer.alloc(1000, 1);
    const srv = await serve({ 'a.zip': body });
    try {
      await expect(
        downloadVerified(
          `${srv.url}/a.zip`,
          join(dir(), 'missing-folder', 'a.zip'),
          { sha512: sha512(body), size: body.length },
          () => {},
        ),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      srv.close();
    }
  });
});

describe('update controller', () => {
  function fakeEngine(over: Partial<UpdateEngine> = {}) {
    const calls = { install: 0 };
    const engine: UpdateEngine = {
      how: 'install',
      after: 'restart',
      check: async () => ({ version: '9.9.9' }),
      async download(onProgress) {
        for (const p of [0, 0, 50, 100]) onProgress(p);
      },
      install: () => void calls.install++,
      ...over,
    };
    return { engine, calls };
  }

  it('asks first: finds, downloads on request, restarts on request', async () => {
    const { engine, calls } = fakeEngine();
    const seen: UpdateStatus[] = [];
    const c = new UpdateController(engine, (s) => seen.push(s));
    expect(c.status).toEqual({ state: 'idle' });
    c.install(); // nothing downloaded yet
    expect(await c.check()).toEqual({ state: 'available', version: '9.9.9', how: 'install' });
    expect(seen.map((s) => s.state)).toEqual(['checking', 'available']);
    expect(await c.download()).toEqual({ state: 'ready', version: '9.9.9', after: 'restart' });
    // Each percentage once.
    expect(seen.filter((s) => s.state === 'downloading').map((s) => s.percent)).toEqual([
      0, 50, 100,
    ]);
    // A later check doesn't throw the download away.
    await c.check();
    expect(c.status.state).toBe('ready');
    c.install();
    expect(calls.install).toBe(1);
  });

  it('says when this version is the latest', async () => {
    const c = new UpdateController(fakeEngine({ check: async () => null }).engine, () => {});
    const s = await c.check();
    expect(s.state).toBe('current');
  });

  it('keeps offering a release while it looks again', async () => {
    const seen: UpdateStatus[] = [];
    const c = new UpdateController(fakeEngine().engine, (s) => seen.push(s));
    await c.check();
    seen.length = 0;
    await c.check();
    expect(seen.map((s) => s.state)).toEqual(['available']);
  });

  it('reports errors, and can try again', async () => {
    let fail = true;
    const c = new UpdateController(
      fakeEngine({
        async download() {
          if (fail) throw new Error('network down\nstack…');
        },
      }).engine,
      () => {},
    );
    await c.check();
    expect(await c.download()).toEqual({
      state: 'error',
      message: 'network down',
      version: '9.9.9',
    });
    fail = false;
    await c.check();
    expect((await c.download()).state).toBe('ready');
  });

  it('a check that fails is an error without a version', async () => {
    const c = new UpdateController(
      fakeEngine({
        check: async () => {
          throw new Error('offline');
        },
      }).engine,
      () => {},
    );
    expect(await c.check()).toEqual({ state: 'error', message: 'offline' });
  });

  it('opens the download page where the app cannot install the update', async () => {
    const { engine, calls } = fakeEngine({ how: 'download' });
    const c = new UpdateController(engine, () => {});
    await c.check();
    await c.download();
    expect(calls.install).toBe(1);
    expect(c.status.state).toBe('available');
  });

  it('does nothing without an engine (a development build)', async () => {
    const c = new UpdateController(null, () => {});
    expect(await c.check()).toEqual({ state: 'unsupported' });
    expect(await c.download()).toEqual({ state: 'unsupported' });
  });
});

describe('manual updates (tar.gz)', () => {
  it('finds a newer release and opens the release page', async () => {
    const srv = await serve({ 'latest-linux.yml': LATEST_LINUX });
    const opened: string[] = [];
    const engine = new ManualEngine({
      currentVersion: '0.3.0',
      feed: srv.url,
      yml: 'latest-linux.yml',
      openExternal: (u) => opened.push(u),
    });
    try {
      expect(await engine.check()).toEqual({ version: '0.3.1' });
      engine.install();
      expect(opened).toEqual(['https://github.com/pwalda/crocodile/releases/latest']);
      const current = new ManualEngine({
        currentVersion: '0.3.1',
        feed: srv.url,
        yml: 'latest-linux.yml',
        openExternal: () => {},
      });
      expect(await current.check()).toBeNull();
    } finally {
      srv.close();
    }
  });
});

describe('macOS in-place updates (unsigned builds)', () => {
  /** A release 0.4.0 whose "zip" the fake unzip turns into Crocodile.app. */
  async function setup(over: Partial<MacSwapDeps> = {}, bundleVersion = '0.4.0') {
    const root = mkdtempSync(join(tmpdir(), 'croc-mac-'));
    const zip = Buffer.from('zip-bytes');
    const dmg = Buffer.from('dmg-bytes');
    const yml = `version: 0.4.0
files:
  - url: Crocodile-0.4.0-mac-universal.zip
    sha512: ${sha512(zip)}
    size: ${zip.length}
  - url: Crocodile-0.4.0-mac-universal.dmg
    sha512: ${sha512(dmg)}
    size: ${dmg.length}
path: Crocodile-0.4.0-mac-universal.zip
`;
    const srv = await serve({
      'latest-mac.yml': yml,
      'Crocodile-0.4.0-mac-universal.zip': zip,
      'Crocodile-0.4.0-mac-universal.dmg': dmg,
    });
    const events: string[] = [];
    let detached: { script: string; args: string[] } | null = null;
    mkdirSync(join(root, 'Downloads'));
    const engine = new MacSwapEngine({
      currentVersion: '0.3.1',
      feed: srv.url,
      bundlePath: join(root, 'Applications', 'Crocodile.app'),
      workDir: join(root, 'update'),
      downloadsDir: join(root, 'Downloads'),
      canReplace: true,
      unzip: async (file, into) => {
        expect(readFileSync(file).equals(zip)).toBe(true);
        mkdirSync(join(into, 'Crocodile.app'));
        writeFileSync(join(into, 'Crocodile.app', 'version'), bundleVersion);
      },
      bundleVersion: async (app) => readFileSync(join(app, 'version'), 'utf8'),
      runDetached: (script, args) => (detached = { script, args }),
      openPath: (p) => events.push(`open ${p}`),
      quit: () => events.push('quit'),
      pid: 4242,
      ...over,
    });
    return { root, srv, engine, events, detached: () => detached };
  }

  it('downloads, checks and stages the new app, then hands over to the swap script', async () => {
    const t = await setup();
    try {
      expect(await t.engine.check()).toEqual({ version: '0.4.0' });
      expect(t.engine.after).toBe('restart');
      await t.engine.download(() => {});
      t.engine.install();
    } finally {
      t.srv.close();
    }
    const staged = join(t.root, 'update', 'app', 'Crocodile.app');
    expect(t.detached()).toEqual({
      script: join(t.root, 'update', 'swap.sh'),
      args: ['4242', join(t.root, 'Applications', 'Crocodile.app'), staged],
    });
    expect(readFileSync(join(t.root, 'update', 'swap.sh'), 'utf8')).toBe(MAC_SWAP_SCRIPT);
    expect(existsSync(join(t.root, 'update', 'update.zip'))).toBe(false);
    expect(t.events).toEqual(['quit']);
  });

  it('refuses an app that is not the version announced', async () => {
    const t = await setup({}, '0.3.9');
    try {
      await t.engine.check();
      await expect(t.engine.download(() => {})).rejects.toThrow(/version 0.3.9, not 0.4.0/);
      t.engine.install();
    } finally {
      t.srv.close();
    }
    expect(t.detached()).toBeNull();
    expect(t.events).toEqual([]);
  });

  it('opens the .dmg when the app cannot replace itself', async () => {
    const t = await setup({ canReplace: false });
    try {
      await t.engine.check();
      expect(t.engine.after).toBe('open');
      await t.engine.download(() => {});
      t.engine.install();
    } finally {
      t.srv.close();
    }
    const dmg = join(t.root, 'Downloads', 'Crocodile-0.4.0-mac-universal.dmg');
    expect(readFileSync(dmg, 'utf8')).toBe('dmg-bytes');
    expect(t.events).toEqual([`open ${dmg}`, 'quit']);
    expect(t.detached()).toBeNull();
  });

  it('finds nothing when this is the latest version', async () => {
    const t = await setup({ currentVersion: '0.4.0' });
    try {
      expect(await t.engine.check()).toBeNull();
      await expect(t.engine.download(() => {})).rejects.toThrow(/no update/);
    } finally {
      t.srv.close();
    }
  });
});

describe('the macOS swap script', () => {
  function bundles() {
    const root = mkdtempSync(join(tmpdir(), 'croc-swap-'));
    const current = join(root, 'Applications', 'Crocodile.app');
    const next = join(root, 'update', 'Crocodile.app');
    mkdirSync(current, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(join(current, 'version'), 'old');
    writeFileSync(join(next, 'version'), 'new');
    const script = join(root, 'swap.sh');
    writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
    return { root, current, next, script };
  }

  it('waits for the app to quit, swaps the bundle and relaunches it', async () => {
    const b = bundles();
    const app = spawn('sleep', ['30']);
    const launched = join(b.root, 'launched');
    const relaunch = join(b.root, 'relaunch.sh');
    writeFileSync(relaunch, `#!/bin/sh\necho "$1" > '${launched}'\n`, { mode: 0o755 });
    const swap = spawn('/bin/sh', [b.script, String(app.pid), b.current, b.next], {
      env: { ...process.env, CROC_RELAUNCH: relaunch },
    });
    const done = new Promise<number | null>((r) => swap.on('exit', r));
    await new Promise((r) => setTimeout(r, 400));
    // Still waiting for the app.
    expect(readFileSync(join(b.current, 'version'), 'utf8')).toBe('old');
    app.kill();
    expect(await done).toBe(0);
    expect(readFileSync(join(b.current, 'version'), 'utf8')).toBe('new');
    expect(existsSync(b.next)).toBe(false);
    expect(readFileSync(launched, 'utf8').trim()).toBe(b.current);
    expect(
      spawnSync('ls', [join(b.root, 'Applications')])
        .stdout.toString()
        .trim(),
    ).toBe('Crocodile.app');
  });

  it('puts the old app back if the new one cannot be moved in', () => {
    const b = bundles();
    const missing = join(b.root, 'update', 'Nothing.app');
    const quit = spawnSync('true').pid;
    const r = spawnSync('/bin/sh', [b.script, String(quit), b.current, missing], {
      env: { ...process.env, CROC_RELAUNCH: 'true' },
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(b.current, 'version'), 'utf8')).toBe('old');
    expect(
      spawnSync('ls', [join(b.root, 'Applications')])
        .stdout.toString()
        .trim(),
    ).toBe('Crocodile.app');
  });
});
