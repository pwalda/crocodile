import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A file system that can't make hard links (some network and removable drives): the file is moved
// into place instead. Other failures are not taken for that.
const linkFails = vi.hoisted(() => ({ code: 'EPERM' }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  link: async () => {
    throw Object.assign(new Error('link failed'), { code: linkFails.code });
  },
}));
import { saveFile } from '../apps/cli/src/save';

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

  it('gives up, leaving nothing, on any other failure', async () => {
    linkFails.code = 'EACCES';
    const dir = folder();
    await expect(
      saveFile(dir, 'a.txt', async (out) => void (await out.write('new'))),
    ).rejects.toThrow(/link failed/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
