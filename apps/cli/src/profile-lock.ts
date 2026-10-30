import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * One process at a time per account. The state file holds the account's keys
 * and ratchets, and each process keeps its own copy in memory and writes the
 * whole file back: two at once would lose each other's changes (a ratchet
 * step, a new prekey) with no error at all. A lock file, created exclusively
 * and holding the process id, makes the second one stop with a clear message.
 * A lock left by a process that is gone (killed, power cut) is taken over.
 */

/** Thrown when another process holds the account. */
export class ProfileInUse extends Error {
  constructor(readonly pid: number | undefined) {
    super(
      `Another Crocodile command${pid ? ` (process ${pid})` : ''} is using this account. ` +
        'Wait for it to finish, or use --profile <name> for a separate account.',
    );
  }
}

/** Locks this process holds, released when it exits however it exits (not a kill). */
const held = new Set<string>();
let exitHook = false;

function releaseAll() {
  for (const path of held) release(path);
}

function release(path: string) {
  held.delete(path);
  try {
    // Only our own: a lock another process has taken over since is not ours to remove.
    if (pidIn(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function pidIn(text: string): number | undefined {
  try {
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No permission to signal it means it exists, as another user's.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock being written has no text yet; one that stays empty is a crash's leftover. */
const UNWRITTEN_MS = 5_000;

/** Takes the lock, or throws ProfileInUse. Returns what to call to give it up. */
export function lockProfile(path: string): () => void {
  if (!exitHook) {
    exitHook = true;
    process.on('exit', releaseAll);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (held.has(path)) throw new ProfileInUse(process.pid);
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        closeSync(fd);
      }
      held.add(path);
      return () => release(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Someone made it first: is it still theirs?
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // gone meanwhile; try again
    }
    const pid = pidIn(text);
    if (pid !== undefined ? alive(pid) : Date.now() - statSync(path).mtimeMs < UNWRITTEN_MS)
      throw new ProfileInUse(pid);
    // Left behind. Remove it only if it is still the very one we looked at.
    try {
      if (readFileSync(path, 'utf8') === text) unlinkSync(path);
    } catch {
      // Taken over by someone else already.
    }
  }
  throw new ProfileInUse(undefined);
}

/** Temporary files a crashed write left beside the state file (each one tried alone). */
export function removeLeftovers(statePath: string) {
  const dir = dirname(statePath);
  const name = basename(statePath);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith(`${name}.`) || !f.endsWith('.tmp')) continue;
    try {
      unlinkSync(join(dir, f));
    } catch {
      // Not a file of ours to remove, or already gone.
    }
  }
}
