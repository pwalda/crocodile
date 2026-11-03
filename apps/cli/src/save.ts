import { constants, lstatSync } from 'node:fs';
import { copyFile, link, open, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';

/** Whether anything is at `path`, a link that leads nowhere included. */
const taken = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    // Not there is a free name; not being able to tell (no access, a drive that went away) is not.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
};

/** Bytes a file name may take: what most file systems allow (as `cleanFileName` keeps to). */
const NAME_MAX_BYTES = 255;

/** `text` cut to at most `bytes` bytes of UTF-8, whole characters only. */
function fit(text: string, bytes: number) {
  const chars = Array.from(text);
  let size = Buffer.byteLength(text);
  while (chars.length > 0 && size > bytes) size -= Buffer.byteLength(chars.pop()!);
  return chars.join('');
}

/** A path in `dir` for `name` that doesn't exist yet: "a.txt", "a (1).txt"… */
export function freePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const suffix = i === 0 ? '' : ` (${i})`;
    // A name that fills the limit gives up some of its stem to the number, and an extension too
    // long to leave room for one is cut with it.
    const room = NAME_MAX_BYTES - Buffer.byteLength(suffix) - Buffer.byteLength(ext);
    const cut = i === 0 ? '' : fit(stem, room);
    const numbered =
      i === 0
        ? name
        : cut
          ? `${cut}${suffix}${ext}`
          : `${fit(name, NAME_MAX_BYTES - Buffer.byteLength(suffix))}${suffix}`;
    const p = join(dir, numbered);
    if (!taken(p)) return p;
  }
}

/** What `sync` fails with where the file system has nothing to flush to. */
const NO_SYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

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
      await out.sync().catch((err) => {
        // Some file systems (FUSE, shares) can't; that is no reason to lose the file.
        if (!NO_SYNC.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      });
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
        // Whatever kept it from linking (no hard links on this file system, another disk, a
        // refusal): copy it, which also fails if the name is taken, and fails the same way if the
        // folder cannot be written to.
        try {
          await copyFile(part, path, constants.COPYFILE_EXCL);
          return path;
        } catch (copyErr) {
          if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
          // The copy made the file and did not finish it: not under the real name.
          await unlink(path).catch(() => {});
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
 * earlier has kept already). Returns the free space and the space needed on the disk that falls short
 * (the one with less, if both do), and which of the two it is; nothing when there is room, or when the free space can't be read.
 */
export async function spaceProblem(dir: string, profileDir: string, size: number, held = 0) {
  const freeIn = async (path: string) => {
    const space = await statfs(path).catch(() => null);
    // A file system that reports nothing at all (no blocks) has not said it is full.
    return space && space.blocks > 0 ? space.bavail * space.bsize : Number.POSITIVE_INFINITY;
  };
  const [here, there] = await Promise.all([stat(dir), stat(profileDir)]).catch(() => []);
  // One disk: the copy in the profile and the saved file draw on the same space. Two disks: each
  // has its own to find.
  const needs =
    here && there && here.dev === there.dev
      ? ([[dir, size * 2 - held, 'both']] as const)
      : ([
          [dir, size, 'folder'],
          [profileDir, size - held, 'profile'],
        ] as const);
  let short: { free: number; needed: number; where: 'folder' | 'profile' | 'both' } | undefined;
  for (const [path, needed, where] of needs) {
    const free = await freeIn(path);
    if (needed > free && (!short || free < short.free)) short = { free, needed, where };
  }
  return short;
}
