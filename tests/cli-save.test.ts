import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSize, plain } from '../apps/cli/src/cli';
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

describe('saving a received file', () => {
  it('puts it in place whole, readable by this user only', async () => {
    const dir = folder();
    const path = await saveFile(dir, 'a.txt', async (out) => void (await out.write('hello')));
    expect(path).toBe(join(dir, 'a.txt'));
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(readdirSync(dir)).toEqual(['a.txt']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('leaves nothing behind when the download fails half way', async () => {
    const dir = folder();
    await expect(
      saveFile(dir, 'a.txt', async (out) => {
        await out.write('half of it');
        throw new Error('the connection dropped');
      }),
    ).rejects.toThrow(/dropped/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never takes the place of a file that is there', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'a.txt'), 'mine');
    const first = await saveFile(dir, 'a.txt', async (out) => void (await out.write('one')));
    const second = await saveFile(dir, 'a.txt', async (out) => void (await out.write('two')));
    expect([first, second]).toEqual([join(dir, 'a (1).txt'), join(dir, 'a (2).txt')]);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(dir).sort()).toEqual(['a (1).txt', 'a (2).txt', 'a.txt']);
  });

  it('keeps saves of the same name apart when they finish together', async () => {
    const dir = folder();
    // All of them have written everything before any of them moves into place.
    let written = 0;
    let everyone!: () => void;
    const together = new Promise<void>((r) => (everyone = r));
    const save = (text: string) =>
      saveFile(dir, 'a.txt', async (out) => {
        await out.write(text);
        if (++written === 20) everyone();
        await together;
      });
    const texts = Array.from({ length: 20 }, (_, i) => `file ${i}`);
    const paths = await Promise.all(texts.map(save));
    expect(new Set(paths).size).toBe(20);
    expect(paths.map((p) => readFileSync(p, 'utf8')).sort()).toEqual([...texts].sort());
    expect(readdirSync(dir)).toHaveLength(20);
  });
});

describe('what the command prints', () => {
  it('has no control characters or direction overrides, only line breaks and tabs', () => {
    expect(plain('alice#1234')).toBe('alice#1234');
    expect(plain('a\tb\nc')).toBe('a\tb\nc');
    expect(plain('日本語 ż')).toBe('日本語 ż');
    // Colour, a window title, a cursor move, a bell, a carriage return, a single-byte CSI.
    for (const bad of ['\x1b[31m', '\x1b]0;title\x07', '\x1b[2J', '\x07', '\r', '\x9b', '\x7f'])
      expect(plain(`a${bad}b`), JSON.stringify(bad)).not.toMatch(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/,
      );
    expect(plain('evil‮gnp.exe')).not.toContain('‮');
    expect(plain('a⁦b')).not.toContain('⁦');
  });
});

describe('--max-size', () => {
  it('reads sizes as they are shown', () => {
    expect(parseSize('500')).toBe(500);
    expect(parseSize('500B')).toBe(500);
    expect(parseSize('2KB')).toBe(2048);
    expect(parseSize('20mb')).toBe(20 * 1024 ** 2);
    expect(parseSize('1.5 GB')).toBe(1.5 * 1024 ** 3);
    expect(parseSize('2g')).toBe(2 * 1024 ** 3);
    expect(parseSize('1TB')).toBe(1024 ** 4);
  });

  it('refuses what is not a size', () => {
    for (const bad of ['', 'big', '-1MB', '1XB', '1 MB MB', 'MB'])
      expect(() => parseSize(bad), bad).toThrow(/isn't a size/);
  });
});
