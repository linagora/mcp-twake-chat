import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireStoreLock, loadOrCreateStoreKey } from '../src/store.js';

const dir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mcp-chat-store-'));

describe('acquireStoreLock', () => {
  it('refuses a second holder while the first process is alive', () => {
    const d = dir();
    const lock = acquireStoreLock(d);
    expect(readFileSync(join(d, '.lock'), 'utf8').trim()).toBe(String(process.pid));
    expect(() => acquireStoreLock(d)).toThrow(/already used by process \d+/);
    lock.release();
    acquireStoreLock(d).release();
  });

  it('takes over a lock left by a dead process', () => {
    const d = dir();
    writeFileSync(join(d, '.lock'), '999999999');
    const lock = acquireStoreLock(d);
    expect(readFileSync(join(d, '.lock'), 'utf8').trim()).toBe(String(process.pid));
    lock.release();
  });
});

describe('loadOrCreateStoreKey', () => {
  it('creates a private 32-byte key once, then reuses it', () => {
    const d = dir();
    const file = join(d, 'sub', 'store.key');
    const k1 = loadOrCreateStoreKey(file);
    expect(k1).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateStoreKey(file)).toEqual(k1);
  });

  it('rejects a key file readable by others or of the wrong size', () => {
    const d = dir();
    const f = join(d, 'k');
    writeFileSync(f, Buffer.alloc(32).toString('base64'), { mode: 0o644 });
    expect(() => loadOrCreateStoreKey(f)).toThrow(/0600/);
    writeFileSync(join(d, 'k2'), 'c2hvcnQ=', { mode: 0o600 });
    expect(() => loadOrCreateStoreKey(join(d, 'k2'))).toThrow(/32 bytes/);
  });
});
