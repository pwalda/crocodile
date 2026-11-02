import { existsSync } from 'node:fs';
import { link, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';

/** A path in `dir` for `name` that doesn't exist yet: "a.txt", "a (1).txt"… */
export function freePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const p = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

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
        if (existsSync(path)) continue;
        await rename(part, path);
        return path;
      }
    }
  } finally {
    await unlink(part).catch(() => {});
  }
}
