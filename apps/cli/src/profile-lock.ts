import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
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
  constructor(
    readonly pid: number | undefined,
    lockFile?: string,
  ) {
    super(
      pid === process.pid
        ? 'This account is already open in this program.'
        : `Another Crocodile command${pid ? ` (process ${pid})` : ''} is using this account. ` +
            'Wait for it to finish, or use --profile <name> for a separate account.' +
            // A process id can be reused by an unrelated program after a crash.
            (lockFile ? ` If none is running, delete ${lockFile}.` : ''),
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
    if (pidIn(readLock(path).text) === process.pid) unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** A lock's text and age, read through one open file so both are of the same file. */
function readLock(path: string): { text: string; ageMs: number } {
  const fd = openSync(path, 'r');
  try {
    return { text: readFileSync(fd, 'utf8'), ageMs: Date.now() - fstatSync(fd).mtimeMs };
  } finally {
    closeSync(fd);
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

/**
 * Removes a lock left behind. The file is first moved aside to a name of our
 * own, which only one process can do; if what was moved was not the lock we
 * looked at (another process took over in between), it is put back.
 */
function takeOver(path: string, seen: string) {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.old`;
  try {
    renameSync(path, aside);
  } catch {
    return; // someone else moved it first
  }
  try {
    if (readLock(aside).text !== seen) {
      try {
        linkSync(aside, path); // fails if yet another lock has been made, which then stands
      } catch {
        // Nothing more to do.
      }
    }
  } catch {
    // Unreadable: nothing to put back.
  }
  try {
    unlinkSync(aside);
  } catch {
    // Already gone.
  }
}

/** Takes the lock, or throws ProfileInUse. Returns what to call to give it up. */
export function lockProfile(path: string): () => void {
  if (!exitHook) {
    exitHook = true;
    process.on('exit', releaseAll);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (held.has(path)) throw new ProfileInUse(process.pid, path);
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
    let found: { text: string; ageMs: number };
    try {
      found = readLock(path);
    } catch {
      continue; // gone meanwhile; try again
    }
    const { text } = found;
    const pid = pidIn(text);
    // Our own id in a lock we do not hold is a crash's leftover too (a container's first process is always 1).
    // A lock with no process id yet may be being written; one that stays so is a crash's leftover.
    const gone =
      pid === undefined ? found.ageMs >= UNWRITTEN_MS : pid === process.pid || !alive(pid);
    if (!gone) throw new ProfileInUse(pid, path);
    takeOver(path, text);
  }
  throw new ProfileInUse(undefined, path);
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
  // The names this program gives: the fixed one of older versions, or "<pid>.<8 hex>".
  const mine = new RegExp(
    `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:\\d+\\.[0-9a-f]{8}\\.)?tmp$`,
  );
  for (const f of files) {
    if (!mine.test(f)) continue;
    try {
      unlinkSync(join(dir, f));
    } catch {
      // Not a file of ours to remove, or already gone.
    }
  }
}
