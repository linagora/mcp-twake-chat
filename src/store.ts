import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The store is held by another living process: a server for this device runs, or is starting. */
export class StoreInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreInUseError';
  }
}

/** 75 (EX_TEMPFAIL) when the store is held by another process, so a client knows another start won; 1 otherwise. */
export function exitCodeOf(error: unknown): number {
  return error instanceof StoreInUseError ? 75 : 1;
}

/** Waits without giving the event loop back: the lock is taken before anything else runs. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** how long a lock file may stay empty (its creator writing its pid) before it counts as left by a crash */
const WRITING_MS = 2000;

/** Creates the lock with our pid in one step (a hard link to a complete file): it is never seen empty. */
function createLock(file: string): boolean {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, `${process.pid}\n`, { mode: 0o600 });
  try {
    linkSync(temporary, file);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw e;
    // a file system without hard links: create, then write (a reader may then see it empty for a moment)
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* gone */
    }
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Removes a stale lock, one process at a time: under a guard file, the lock is read again and removed only if it is
 * still the stale one this process saw. Without the guard, a second process could remove the lock the first had just
 * taken over, and two processes would hold the store.
 */
function takeOver(file: string, seen: string): void {
  const guard = `${file}.takeover`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // another process is taking over; a guard left by a process that died there is removed
    const owner = Number((readText(guard) ?? '').trim());
    let old = false;
    try {
      old = Date.now() - statSync(guard).mtimeMs > WRITING_MS;
    } catch {
      /* gone */
    }
    if ((owner && !alive(owner)) || (!owner && old)) {
      try {
        unlinkSync(guard);
      } catch {
        /* gone */
      }
    }
    pause(10);
    return;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    if (readText(file) === seen) unlinkSync(file);
  } finally {
    try {
      if ((readText(guard) ?? '').trim() === String(process.pid)) unlinkSync(guard);
    } catch {
      /* gone */
    }
  }
}

/**
 * One Matrix device = one process. Two processes on the same crypto store corrupt the Olm sessions, so the store
 * directory carries an exclusive lock file holding the owner's pid; a lock left by a dead process is taken over. Several
 * processes may start at the same moment (mcp-twake-ai's shared mode): the lock is created whole, a lock being written
 * is waited for, and a stale one is taken over by one process at a time.
 */
export function acquireStoreLock(storeDir: string): { release(): void } {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const file = join(storeDir, '.lock');
  let waited = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (createLock(file)) {
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    }
    const seen = readText(file);
    if (seen === undefined) continue; // removed meanwhile: try again
    const pid = Number(seen.trim());
    if (!pid) {
      // being written by its creator (or left empty by a crash, once it stays so)
      if (waited < WRITING_MS) {
        pause(25);
        waited += 25;
        continue;
      }
    } else if (pid === process.pid) {
      throw new Error(`the Matrix device store ${storeDir} is already used by process ${pid} (this process)`);
    } else if (alive(pid)) {
      throw new StoreInUseError(
        `the Matrix device store ${storeDir} is already used by process ${pid}: run a single mcp-twake-chat per device (use the HTTP transport to share it)`,
      );
    }
    takeOver(file, seen);
  }
  throw new Error(`cannot lock ${storeDir}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 32-byte key encrypting the crypto store, kept in a 0600 file (created on first use). */
/** On Windows a file has no POSIX mode (stat reads 0666): its folder in the user's profile is what keeps it private. */
export function loadOrCreateStoreKey(file: string, platform: NodeJS.Platform = process.platform): Uint8Array {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
  }
  const mode = statSync(file).mode & 0o777;
  if (platform !== 'win32' && mode & 0o077) throw new Error(`${file} is readable by group/others (mode ${mode.toString(8)}): chmod 0600 it`);
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} must hold 32 bytes encoded in base64`);
  return new Uint8Array(key);
}
