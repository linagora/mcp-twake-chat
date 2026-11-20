import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeStateFile, writeStateFile, type SharedState } from '../src/state-file.js';

const state = (pid: number): SharedState => ({
  version: 1,
  pid,
  url: 'http://127.0.0.1:41873/mcp',
  token: 'a'.repeat(64),
  userId: '@j:x',
  deviceId: 'D1',
  serverVersion: '0.7.0',
  startedAt: '2026-11-20T10:00:00.000Z',
});

describe('state file', () => {
  it('is written whole, readable by the user only, in a private folder', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'chat-state-')), 'agent');
    const file = join(dir, 'server.json');
    writeStateFile(file, state(42));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(state(42));
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('is removed by the process it names only', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'chat-state-')), 'server.json');
    writeStateFile(file, state(42));
    removeStateFile(file, 43);
    expect(existsSync(file)).toBe(true);
    removeStateFile(file, 42);
    expect(existsSync(file)).toBe(false);
    removeStateFile(file, 42); // gone already: nothing to do
  });

  it('leaves a file it cannot read alone', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'chat-state-')), 'server.json');
    writeFileSync(file, '{bad');
    removeStateFile(file, 42);
    expect(existsSync(file)).toBe(true);
  });
});
