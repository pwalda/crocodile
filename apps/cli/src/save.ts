import { constants, lstatSync } from 'node:fs';
import { copyFile, link, open, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
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

/** Bytes a file name may take: what most file systems allow (as `cleanFileName` keeps to). */
const NAME_MAX_BYTES = 255;

/** `text` cut to at most `bytes` bytes of UTF-8, whole characters only. */
function fit(text: string, bytes: number) {
  let out = text;
  while (Buffer.byteLength(out) > bytes) out = out.slice(0, -1);
  return out;
}

/** A path in `dir` for `name` that doesn't exist yet: "a.txt", "a (1).txt"… */
export function freePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const suffix = i === 0 ? '' : ` (${i})`;
    // A name that fills the limit gives up some of its stem to the number.
    const room = NAME_MAX_BYTES - Buffer.byteLength(suffix) - Buffer.byteLength(ext);
    const p = join(dir, i === 0 ? name : `${fit(stem, room)}${suffix}${ext}`);
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
  const part = join(dir, `.crocodile-${randomBytes(8).toString('hex')}.part`);
  const out = await open(part, 'wx', 0o600);
  try {
    try {
      await write(out);
      // On disk before the name shows it: a crash must not leave a short file under the real name.
      await out.sync();
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
        // A file system without hard links: copy it, which also fails if the name is taken.
        if (!NO_LINKS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
        try {
          await copyFile(part, path, constants.COPYFILE_EXCL);
          return path;
        } catch (copyErr) {
          if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw copyErr;
        }
      }
    }
  } finally {
    await unlink(part).catch(() => {});
  }
}

/**
 * Why a file of `size` bytes shouldn't be taken into `dir`, if it shouldn't: the space it needs is
 * there once for the copy kept in the profile while it downloads and once more for the saved
 * file, and those are one pool when both are on the same disk (less what a download stopped
 * earlier has kept already). The free space when there is not
 * enough; nothing when there is, or when it can't be read.
 */
export async function spaceProblem(dir: string, profileDir: string, size: number, held = 0) {
  const space = await statfs(dir).catch(() => null);
  if (!space) return undefined;
  const [here, there] = await Promise.all([stat(dir), stat(profileDir)]).catch(() => []);
  const free = space.bavail * space.bsize;
  const needed = here && there && here.dev === there.dev ? size * 2 - held : size;
  return needed > free ? free : undefined;
}
