/**
 * One process per device store, even when several start at the same moment (the shared mode of mcp-twake-ai makes
 * that the normal case): the lock must never have two holders.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireStoreLock, StoreInUseError } from '../src/store.js';

// the built module: these processes run plain node
const store = fileURLToPath(new URL('../build/store.js', import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), 'chat-lock-race-'));

/** n processes that wait for the same instant, take the lock, and say whether they hold it after a moment */
async function race(dir: string, n: number): Promise<number> {
  const at = Date.now() + 600;
  const script = `
    const { acquireStoreLock } = await import(${JSON.stringify(pathToFileURL(store).href)});
    while (Date.now() < ${at}) {}
    let held = false;
    try { acquireStoreLock(${JSON.stringify(dir)}); held = true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
    process.stdout.write(held ? 'held' : 'refused');
  `;
  const runs = Array.from(
    { length: n },
    () =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (c: Buffer) => (out += c.toString()));
        child.on('close', () => resolve(out));
      }),
  );
  return (await Promise.all(runs)).filter((out) => out === 'held').length;
}

describe.skipIf(!existsSync(store))('the store lock under simultaneous starts', () => {
  it('waits for a lock being written instead of taking it for a stale one', async () => {
    const dir = temp();
    const lock = join(dir, '.lock');
    // another process created the lock and has not written its pid yet: it does 150 ms later
    writeFileSync(lock, '');
    const writer = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(lock)}, '${process.ppid}'), 150)`]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let caught: unknown;
    try {
      acquireStoreLock(dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreInUseError);
    await new Promise((resolve) => writer.once('exit', resolve));
  });

  it('has one holder when several processes take over a stale lock at once', { timeout: 120_000 }, async () => {
    for (let round = 0; round < 12; round++) {
      const dir = temp();
      writeFileSync(join(dir, '.lock'), '999999999\n');
      expect(await race(dir, 4)).toBe(1);
    }
  });

  it('has one holder when several processes take a new store at once', { timeout: 120_000 }, async () => {
    for (let round = 0; round < 12; round++) expect(await race(temp(), 4)).toBe(1);
  });
});
