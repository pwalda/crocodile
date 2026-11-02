import { lstatSync } from 'node:fs';
import { link, open, rename, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';

/** Whether anything is at `path`, a link that leads nowhere included. */
const taken = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** A path in `dir` for `name` that doesn't exist yet: "a.txt", "a (1).txt"… */
export function freePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const p = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!taken(p)) return p;
  }
}

/** What `link` fails with where the file system can't make hard links. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

/**
 * Writes a file into `dir` under `name` (or the first free "name (1)"…), readable by this user
 * only. It is written beside its place under another name and moved in once complete, so a
 * download that fails leaves nothing behind, and a name is never taken over.
 */
export async function saveFile(
  dir: string,
  name: string,
  write: (out: FileHandle) => Promise<void>,
): Promise<string> {
  const part = join(dir, `.${randomBytes(8).toString('hex')}.part`);
  const out = await open(part, 'wx', 0o600);
  try {
    try {
      await write(out);
    } finally {
      await out.close();
    }
    for (;;) {
      const path = freePath(dir, name);
      try {
        // Fails if the name has been taken in the meantime.
        await link(part, path);
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        // A file system without hard links: move it, unless the name is taken.
        if (!NO_LINKS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
        if (taken(path)) continue;
        await rename(part, path);
        return path;
      }
    }
  } finally {
    await unlink(part).catch(() => {});
  }
}

/**
 * Why a file of `size` bytes shouldn't be taken into `dir`, if it shouldn't: the space it needs is
 * there once for the copy kept in the profile while it downloads and once more for the saved
 * file, and those are one pool when both are on the same disk. The free space when there is not
 * enough; nothing when there is, or when it can't be read.
 */
export async function spaceProblem(dir: string, profileDir: string, size: number) {
  const space = await statfs(dir).catch(() => null);
  if (!space) return undefined;
  const [here, there] = await Promise.all([stat(dir), stat(profileDir)]).catch(() => []);
  const free = space.bavail * space.bsize;
  const needed = here && there && here.dev === there.dev ? size * 2 : size;
  return needed > free ? free : undefined;
}
