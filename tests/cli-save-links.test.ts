import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A file system that can't make hard links (some network and removable drives): the file is moved
// into place instead. Other failures are not taken for that.
const linkFails = vi.hoisted(() => ({ code: 'EPERM', plant: '', copyFails: '', syncFails: '' }));
// Disks that are not the machine's: free space and device number by path, where set.
const disks = vi.hoisted(() => ({
  free: new Map<string, number>(),
  dev: new Map<string, number>(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (_from: string, to: string) => {
      // Someone else takes the name just before the file would.
      if (linkFails.plant) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(to, linkFails.plant);
        linkFails.plant = '';
      }
      throw Object.assign(new Error('link failed'), { code: linkFails.code });
    },
    // A copy that makes the file and then fails (the disk is full).
    copyFile: async (from: string, to: string, mode?: number) => {
      if (linkFails.copyFails) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(to, 'half of it');
        throw Object.assign(new Error('copy failed'), { code: linkFails.copyFails });
      }
      return actual.copyFile(from, to, mode);
    },
    // A file system that cannot flush, or a disk that fails while flushing.
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (linkFails.syncFails)
        handle.sync = async () => {
          throw Object.assign(new Error('sync failed'), { code: linkFails.syncFails });
        };
      return handle;
    },
    statfs: async (path: string) =>
      disks.free.has(path) ? { bavail: disks.free.get(path)!, bsize: 1 } : actual.statfs(path),
    stat: async (path: string) =>
      disks.dev.has(path) ? { dev: disks.dev.get(path)! } : actual.stat(path),
  };
});
import { saveFile, spaceProblem } from '../apps/cli/src/save';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = () => {
  const d = mkdtempSync(join(tmpdir(), 'croc-save-'));
  dirs.push(d);
  return d;
};

describe('saving where there are no hard links', () => {
  it('moves the file into place, and still not over a file that is there', async () => {
    linkFails.code = 'ENOTSUP';
    const dir = folder();
    writeFileSync(join(dir, 'a.txt'), 'mine');
    const path = await saveFile(dir, 'a.txt', async (out) => void (await out.write('new')));
    expect(path).toBe(join(dir, 'a (1).txt'));
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(dir).sort()).toEqual(['a (1).txt', 'a.txt']);
  });

  it('does not take over a name that is taken at the last moment', async () => {
    linkFails.code = 'EPERM';
    linkFails.plant = 'theirs';
    const dir = folder();
    const path = await saveFile(dir, 'a.txt', async (out) => void (await out.write('new')));
    expect(path).toBe(join(dir, 'a (1).txt'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('theirs');
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readdirSync(dir).sort()).toEqual(['a (1).txt', 'a.txt']);
  });

  it('leaves no half a file under the name when the copy fails', async () => {
    linkFails.code = 'EPERM';
    linkFails.copyFails = 'ENOSPC';
    const dir = folder();
    try {
      await expect(
        saveFile(dir, 'a.txt', async (out) => void (await out.write('new'))),
      ).rejects.toThrow(/copy failed/);
    } finally {
      linkFails.copyFails = '';
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('goes on where the file system has nothing to flush to', async () => {
    linkFails.code = 'EPERM';
    linkFails.syncFails = 'ENOTSUP';
    const dir = folder();
    try {
      const path = await saveFile(dir, 'a.txt', async (out) => void (await out.write('new')));
      expect(readFileSync(path, 'utf8')).toBe('new');
    } finally {
      linkFails.syncFails = '';
    }
  });

  it('stops, leaving nothing, when flushing fails for real', async () => {
    linkFails.code = 'EPERM';
    linkFails.syncFails = 'EIO';
    const dir = folder();
    try {
      await expect(
        saveFile(dir, 'a.txt', async (out) => void (await out.write('new'))),
      ).rejects.toThrow(/sync failed/);
    } finally {
      linkFails.syncFails = '';
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('gives up, leaving nothing, on any other failure', async () => {
    linkFails.code = 'EACCES';
    const dir = folder();
    await expect(
      saveFile(dir, 'a.txt', async (out) => void (await out.write('new'))),
    ).rejects.toThrow(/link failed/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('room on the disks involved', () => {
  afterEach(() => {
    disks.free.clear();
    disks.dev.clear();
  });
  const disk = (dir: string, profile: string, dirDev: number, profileDev: number) => {
    disks.dev.set(dir, dirDev);
    disks.dev.set(profile, profileDev);
  };

  it('is found on both when the profile is on another disk', async () => {
    const [dir, profile] = [folder(), folder()];
    disk(dir, profile, 1, 2);
    disks.free.set(dir, 100);
    disks.free.set(profile, 10);
    // The download is kept in the profile first: 50 bytes do not fit there.
    expect(await spaceProblem(dir, profile, 50)).toEqual({
      free: 10,
      needed: 50,
      where: 'profile',
    });
    // Most of it is there already.
    expect(await spaceProblem(dir, profile, 50, 45)).toBeUndefined();
    // And the folder itself too small.
    expect(await spaceProblem(dir, profile, 150, 145)).toEqual({
      free: 100,
      needed: 150,
      where: 'folder',
    });
  });

  it('is found once, doubled, on one disk', async () => {
    const [dir, profile] = [folder(), folder()];
    disk(dir, profile, 1, 1);
    disks.free.set(dir, 100);
    disks.free.set(profile, 5);
    expect(await spaceProblem(dir, profile, 60)).toEqual({
      free: 100,
      needed: 120,
      where: 'folder',
    });
    expect(await spaceProblem(dir, profile, 40)).toBeUndefined();
    expect(await spaceProblem(dir, profile, 60, 30)).toBeUndefined();
  });
});
