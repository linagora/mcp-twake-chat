import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One Matrix device = one process. Two processes on the same crypto store
 * corrupt the Olm sessions, so the store directory carries an exclusive
 * lock file holding the owner's pid; a lock left by a dead process is taken over.
 */
export function acquireStoreLock(storeDir: string): { release(): void } {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const file = join(storeDir, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid)) {
        throw new Error(
          `the Matrix device store ${storeDir} is already used by process ${pid}: run a single mcp-twake-chat per device (use the HTTP transport to share it)`,
        );
      }
      if (pid === process.pid) throw new Error(`the Matrix device store ${storeDir} is already used by process ${pid} (this process)`);
      unlinkSync(file); // stale
    }
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
export function loadOrCreateStoreKey(file: string): Uint8Array {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
  }
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} is readable by group/others (mode ${mode.toString(8)}): chmod 0600 it`);
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} must hold 32 bytes encoded in base64`);
  return new Uint8Array(key);
}
