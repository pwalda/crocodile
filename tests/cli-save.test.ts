import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inline, parseSize, plain, receivedName } from '../apps/cli/src/cli';
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

  it.skipIf(process.platform === 'win32')(
    'goes round a name taken by a link that leads nowhere',
    async () => {
      const dir = folder();
      symlinkSync(join(dir, 'nowhere'), join(dir, 'a.txt'));
      const path = await saveFile(dir, 'a.txt', async (out) => void (await out.write('hi')));
      expect(path).toBe(join(dir, 'a (1).txt'));
      expect(readdirSync(dir).sort()).toEqual(['a (1).txt', 'a.txt']);
    },
  );

  it('numbers a name that already fills the limit without going over it', async () => {
    const dir = folder();
    const name = `${'a'.repeat(251)}.txt`;
    const second = `${'é'.repeat(125)}.txt`; // 250 + 4 bytes
    for (const n of [name, second]) {
      expect(Buffer.byteLength(n)).toBeLessThanOrEqual(255);
      writeFileSync(join(dir, n), 'first');
      const path = await saveFile(dir, n, async (out) => void (await out.write('again')));
      expect(path).not.toBe(join(dir, n));
      const saved = path.slice(dir.length + 1);
      expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(255);
      expect(saved).toMatch(/ \(1\)\.txt$/);
      expect(readFileSync(path, 'utf8')).toBe('again');
      expect(readFileSync(join(dir, n), 'utf8')).toBe('first');
    }
  });

  it('numbers a name whose extension takes all the room', async () => {
    const dir = folder();
    // 254 bytes, nearly all of it extension: no room for a number beside the extension.
    for (const name of [`a.${'b'.repeat(252)}`, `${'é'.repeat(4)}.${'ü'.repeat(120)}`]) {
      writeFileSync(join(dir, name), 'first');
      const path = await saveFile(dir, name, async (out) => void (await out.write('again')));
      const saved = path.slice(dir.length + 1);
      expect(saved).not.toBe(name);
      expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(255);
      expect(saved).toContain(' (1)');
      expect(readFileSync(path, 'utf8')).toBe('again');
    }
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
    expect(plain('evil\u202egnp.exe')).not.toContain('\u202e');
    expect(plain('a\u2066b')).not.toContain('\u2066');
    // Direction marks, line and paragraph separators, a byte order mark.
    for (const bad of ['\u200e', '\u200f', '\u061c', '\u2028', '\u2029', '\ufeff'])
      expect(plain(`a${bad}b`), JSON.stringify(bad)).toBe('a?b');
    // Zero-width and invisible characters, a soft hyphen, tag characters (hidden text).
    for (const bad of ['\u200b', '\u2060', '\u2064', '\u00ad', '\u{e0041}', '\u180e'])
      expect(plain(`a${bad}b`), JSON.stringify(bad)).toBe('a?b');
    // The non-joiner Persian is written with stays too.
    expect(plain('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645')).toContain('\u200c');
    // The joiner in an emoji family stays.
    expect(plain('\u{1F468}\u200d\u{1F469}\u200d\u{1F467}')).toBe(
      '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}',
    );
  });
});

describe('the name a received file gets', () => {
  it('has nothing in it a terminal would act on, nor a direction mark', () => {
    expect(receivedName('report.pdf')).toBe('report.pdf');
    expect(receivedName('日本語 ż.txt')).toBe('日本語 ż.txt');
    expect(receivedName('x\u009by.txt')).toBe('x_y.txt');
    expect(receivedName('a\u2028Saved passwd')).toBe('a_Saved passwd');
    expect(receivedName('a\u200fb\u061cc\ufeffd')).toBe('a_b_c_d');
    expect(receivedName('../../x\x1b[2J')).toBe('x_[2J');
  });
});

describe('a name on one line', () => {
  it('has no line break or tab left in it', () => {
    expect(inline('alice\nSaved /etc/x\t#1234')).toBe('alice Saved /etc/x #1234');
    expect(inline('al\x1b[31mice')).toBe('al?[31mice');
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
    for (const bad of ['', 'big', '-1MB', '1XB', '1 MB MB', 'MB', '0', '0MB', '0.0001'])
      expect(() => parseSize(bad), bad).toThrow(/isn't a size/);
  });
});

describe('room for a file', () => {
  const room = async (dir: string) => {
    const { statfs } = await import('node:fs/promises');
    const space = await statfs(dir);
    return space.bavail * space.bsize;
  };

  it('is there for a small file and not for one bigger than the disk', async () => {
    const dir = folder();
    expect(await spaceProblem(dir, dir, 1)).toBeUndefined();
    const free = await spaceProblem(dir, dir, Number.MAX_SAFE_INTEGER);
    expect(free).toBeGreaterThan(0);
    expect(free).toBeLessThanOrEqual(await room(dir));
  });

  it('is needed twice when the copy kept while downloading is on the same disk', async () => {
    const dir = folder();
    const profile = folder();
    // 60% of the free space fits once, not twice.
    const size = Math.floor((await room(dir)) * 0.6);
    expect(await spaceProblem(dir, profile, size)).toBeGreaterThan(0);
    expect(await spaceProblem(dir, profile, Math.floor(size / 4))).toBeUndefined();
  });

  it('counts what a stopped download has kept already', async () => {
    const dir = folder();
    const profile = folder();
    const size = Math.floor((await room(dir)) * 0.6);
    expect(await spaceProblem(dir, profile, size, 0)).toBeGreaterThan(0);
    // Most of it is in the profile: little more is needed.
    expect(await spaceProblem(dir, profile, size, Math.floor(size * 0.9))).toBeUndefined();
  });

  it('is taken as there when the free space cannot be read', async () => {
    expect(
      await spaceProblem(join(folder(), 'missing'), join(folder(), 'gone'), 1e15),
    ).toBeUndefined();
  });
});
