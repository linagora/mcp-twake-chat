import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * What the shared HTTP mode publishes once it holds its store and listens (MCP_HTTP_STATE_FILE): a client finds the
 * server here, checks it with the token, and stops it with the token. Its existence proves both the lock and the port.
 */
export interface SharedState {
  version: 1;
  pid: number;
  url: string;
  token: string;
  userId: string;
  deviceId: string;
  serverVersion: string;
  startedAt: string;
}

/** Written whole (a temporary file, then a rename), 0600 in a 0700 folder: a reader never sees half of it. */
export function writeStateFile(file: string, state: SharedState): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const temporary = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Only the process the file names removes it: a newer server may have written its own since. */
export function removeStateFile(file: string, pid: number): void {
  let named: unknown;
  try {
    named = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return;
  }
  if (named !== pid) return;
  try {
    unlinkSync(file);
  } catch {
    // gone already
  }
}
