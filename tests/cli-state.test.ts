import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Io } from '../apps/cli/src/cli';
import { JsonFileStore } from '../apps/cli/src/platform';
import { ProfileInUse } from '../apps/cli/src/profile-lock';

/** The account's state file: one process at a time, and a write that never leaves half a file. */

const dirs: string[] = [];
const children: { kill(): boolean }[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'croc-state-'));
  dirs.push(d);
  return d;
}

describe('the account state file', () => {
  it('is held by one process at a time, and free again once it closes', async () => {
    const path = join(tempDir(), 'state.json');
    const first = new JsonFileStore(path);
    await first.set('seed', 'abc');
    expect(() => new JsonFileStore(path)).toThrow(ProfileInUse);
    expect(() => new JsonFileStore(path)).toThrow(/Another Crocodile command.*--profile/);
    first.close();
    const second = new JsonFileStore(path);
    expect(await second.get('seed')).toBe('abc');
    second.close();
  });

  it('is not lost to a second process that read it before the first one saved', async () => {
    // What the lock prevents: both would load {}, each save its own change, and one would be gone.
    const path = join(tempDir(), 'state.json');
    const a = new JsonFileStore(path);
    expect(() => new JsonFileStore(path)).toThrow(ProfileInUse);
    await a.set('ratchet', 1);
    a.close();
    const b = new JsonFileStore(path);
    await b.set('prekey', 2);
    b.close();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ratchet: 1, prekey: 2 });
  });

  it('is refused while a live process of another program holds the lock', () => {
    const path = join(tempDir(), 'state.json');
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    children.push(other);
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: other.pid, at: Date.now() }));
    expect(() => new JsonFileStore(path)).toThrow(new RegExp(`process ${other.pid}`));
  });

  it('is taken over from a process that is gone', async () => {
    const path = join(tempDir(), 'state.json');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: dead, at: Date.now() }));
    const store = new JsonFileStore(path);
    await store.set('k', 'v');
    store.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('waits for a lock that is still being written, and takes over one that never was', () => {
    const path = join(tempDir(), 'state.json');
    writeFileSync(`${path}.lock`, '');
    expect(() => new JsonFileStore(path)).toThrow(ProfileInUse);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    new JsonFileStore(path).close();
  });

  it('gives the lock up when it cannot be read, so a damaged file does not lock the account', () => {
    const path = join(tempDir(), 'state.json');
    writeFileSync(path, '{ not json');
    expect(() => new JsonFileStore(path)).toThrow(/damaged/);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  it('saves even when the old fixed temporary name is taken, and clears leftovers', async () => {
    const path = join(tempDir(), 'state.json');
    // What an interrupted older version left, and something else that is in the way.
    mkdirSync(`${path}.tmp`);
    writeFileSync(`${path}.123.dead.tmp`, 'half a file');
    writeFileSync(`${path}.tmp`.replace('.tmp', '.9.tmp'), 'x');
    const store = new JsonFileStore(path);
    expect(existsSync(`${path}.123.dead.tmp`)).toBe(false);
    await store.set('k', 'v');
    store.close();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ k: 'v' });
    expect(readdirSync(join(path, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([
      'state.json.tmp',
    ]);
    expect(statLikeMode(path)).toBe(0o600);
  });

  it('does not write after it was closed', async () => {
    const path = join(tempDir(), 'state.json');
    const a = new JsonFileStore(path);
    await a.set('k', 1);
    a.close();
    const b = new JsonFileStore(path);
    await b.set('k', 2);
    await a.set('k', 3);
    a.flush();
    b.close();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ k: 2 });
  });
});

function statLikeMode(path: string): number {
  return process.platform === 'win32' ? 0o600 : statSync(path).mode & 0o777;
}

describe('crocodile commands on the same account', () => {
  it('stop with a clear message while another holds the account, and work again after', async () => {
    const home = tempDir();
    const err: string[] = [];
    const io: Io = {
      out: () => {},
      err: (l) => err.push(l),
      env: { CROCODILE_HOME: home, CROCODILE_DIRECTORIES: '' },
      cwd: home,
      interrupted: new Promise(() => {}),
    };
    const holder = new JsonFileStore(join(home, 'state.json'));
    expect(await run(['whoami', '--server', 'http://127.0.0.1:1'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Another Crocodile command .* is using this account/);
    holder.close();
    err.length = 0;
    // Not signed in yet, but it got as far as the account: it is not the lock that stops it.
    await run(['whoami', '--server', 'http://127.0.0.1:1'], io);
    expect(err.join('\n')).not.toMatch(/is using this account/);
  });
});
