/**
 * The shared HTTP mode mcp-twake-ai starts, finds and stops (spec shared-chat §2): port 0, the state file written once
 * the server listens and removed when it stops, a token drawn here and written nowhere else, exit 75 on a held store.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { startHttp } from '../src/http.js';
import { serveHttp } from '../src/shared-mode.js';

const newServer = () => new McpServer({ name: 't', version: '0' });
const ping = (url: string, token?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
const temp = () => mkdtempSync(join(tmpdir(), 'chat-shared-'));
const identity = () => ({ userId: '@j:example.com', deviceId: 'DEVICEONE' });

describe('startHttp', () => {
  it('listens on a port the system picks and accepts its own host', async () => {
    const s = await startHttp(newServer, { host: '127.0.0.1', port: 0, secret: 'k' });
    expect(s.port).toBeGreaterThan(0);
    const r = await ping(s.url, 'k');
    expect(r.status).toBe(200);
    await s.close();
  });
});

describe('serveHttp (the shared mode)', () => {
  it('publishes its state once it listens, with a token it drew and requires', async () => {
    const dir = join(temp(), 'agent');
    const stateFile = join(dir, 'server.json');
    const logs: string[] = [];
    const served = await serveHttp(newServer, { host: '127.0.0.1', port: 0, stateFile, version: '9.9.9', identity, onStop: () => {}, log: (_l, m) => logs.push(m) });
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state).toMatchObject({ version: 1, pid: process.pid, url: served.url, userId: '@j:example.com', deviceId: 'DEVICEONE', serverVersion: '9.9.9' });
    expect(state.token).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(state.startedAt))).toBe(false);
    expect(new URL(state.url).port).not.toBe('0');
    if (process.platform !== 'win32') {
      expect(statSync(stateFile).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect((await ping(served.url)).status).toBe(401);
    expect((await ping(served.url, 'f'.repeat(64))).status).toBe(401);
    expect((await ping(served.url, state.token)).status).toBe(200);
    // the token is in the state file only
    expect(logs.join('\n')).not.toContain(state.token);
    expect(Object.values(process.env).some((v) => v?.includes(state.token))).toBe(false);
    await served.close();
    expect(existsSync(stateFile)).toBe(false);
  });

  it('copies the token of MCP_HTTP_TOKEN_FILE into the state file', async () => {
    const dir = temp();
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'given-token\n', { mode: 0o600 });
    const stateFile = join(dir, 'server.json');
    const served = await serveHttp(newServer, { host: '127.0.0.1', port: 0, tokenFile, stateFile, version: '0', identity, onStop: () => {} });
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).token).toBe('given-token');
    expect((await ping(served.url, 'given-token')).status).toBe(200);
    await served.close();
  });

  it('writes no state file when it cannot listen', async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = (taken.address() as AddressInfo).port;
    const stateFile = join(temp(), 'server.json');
    await expect(serveHttp(newServer, { host: '127.0.0.1', port, stateFile, version: '0', identity, onStop: () => {} })).rejects.toThrow(/EADDRINUSE/);
    expect(existsSync(stateFile)).toBe(false);
    await new Promise((r) => taken.close(r));
  });

  it('stops on its shutdown route: the state file goes, then the port', async () => {
    const stateFile = join(temp(), 'server.json');
    let served: Awaited<ReturnType<typeof serveHttp>> | undefined;
    const stopped = new Promise<void>((resolve) => {
      void serveHttp(newServer, { host: '127.0.0.1', port: 0, stateFile, version: '0', identity, onStop: () => void served?.close().then(resolve) }).then((s) => (served = s));
    });
    await new Promise((r) => setTimeout(r, 100));
    const { url, token } = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect((await fetch(`${url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(202);
    await stopped;
    expect(existsSync(stateFile)).toBe(false);
    await expect(ping(url, token)).rejects.toThrow();
  });

  it('stops once idle', async () => {
    const stateFile = join(temp(), 'server.json');
    let idle = 0;
    const served = await serveHttp(newServer, { host: '127.0.0.1', port: 0, stateFile, exitWhenIdleMs: 200, version: '0', identity, onStop: () => void idle++ });
    await new Promise((r) => setTimeout(r, 500));
    expect(idle).toBe(1);
    await served.close();
  });

  it('leaves a state file a newer server wrote alone', async () => {
    const stateFile = join(temp(), 'server.json');
    const served = await serveHttp(newServer, { host: '127.0.0.1', port: 0, stateFile, version: '0', identity, onStop: () => {} });
    const newer = { ...JSON.parse(readFileSync(stateFile, 'utf8')), pid: process.pid + 1 };
    writeFileSync(stateFile, JSON.stringify(newer));
    await served.close();
    expect(existsSync(stateFile)).toBe(true);
  });
});

const bin = fileURLToPath(new URL('../build/index.js', import.meta.url));

describe.skipIf(!existsSync(bin))('the built server', { timeout: 30_000 }, () => {
  it('exits with 75 when another living process holds its store', async () => {
    const store = temp();
    // this test process is alive, and is not the server
    writeFileSync(join(store, '.lock'), `${process.pid}\n`);
    const env = {
      PATH: process.env.PATH,
      HOME: temp(),
      MATRIX_USER_ID: '@j:localhost',
      MATRIX_ACCESS_TOKEN: 't',
      MATRIX_DEVICE_ID: 'DEVICEONE',
      MATRIX_HOMESERVER_URL: 'http://localhost:9',
      TOM_URL: 'http://localhost:9',
      MATRIX_STORE_DIR: store,
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: '0',
      MCP_HTTP_STATE_FILE: join(store, 'server.json'),
    };
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [bin], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c: Buffer) => (err += c.toString()));
      child.on('close', (code) => resolve({ code, err }));
    });
    expect(r.err).toMatch(new RegExp(`already used by process ${process.pid}`));
    expect(r.code).toBe(75);
    expect(existsSync(join(store, 'server.json'))).toBe(false);
  });
});
