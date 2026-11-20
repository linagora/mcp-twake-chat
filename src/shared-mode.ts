/**
 * The HTTP transport, and the shared mode mcp-twake-ai runs (MCP_HTTP_STATE_FILE): one server per Matrix device, which
 * its clients find in the state file, check and stop with the token it holds. The token is drawn here when no token
 * file is given and written into the state file only (never into the environment nor a log line). The state file is
 * written once the store is held (before this is called) and the port listens, and removed first when stopping.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttp, type HttpOptions } from './http.js';
import { removeStateFile, writeStateFile } from './state-file.js';

/** a session whose client's event stream is closed and which says nothing for this long is gone */
const ORPHAN_MS = 60_000;

export interface ServeOptions {
  host: string;
  port: number;
  tokenFile?: string;
  stateFile?: string;
  exitWhenIdleMs?: number;
  version: string;
  identity(): { userId: string; deviceId: string };
  /** the shutdown route or the idle delay asks the process to stop (it then calls close()) */
  onStop(): void;
  log?: HttpOptions['log'];
}

export async function serveHttp(newServer: () => McpServer, o: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  const secret = o.tokenFile ? readFileSync(o.tokenFile, 'utf8').trim() : o.stateFile ? randomBytes(32).toString('hex') : undefined;
  const served = await startHttp(newServer, {
    host: o.host,
    port: o.port,
    secret,
    log: o.log,
    exitWhenIdleMs: o.exitWhenIdleMs,
    // the shared mode's clients are mcp-twake-ai relays, which keep an event stream open while they live: a client
    // killed without a DELETE (SIGKILL, Windows) must not keep the server for the 6 hours of idleMs
    ...(o.stateFile ? { orphanMs: ORPHAN_MS } : {}),
    onShutdown: () => o.onStop(),
    onIdle: () => {
      o.log?.('info', `no session for ${Math.round((o.exitWhenIdleMs ?? 0) / 1000)} s: stopping`);
      o.onStop();
    },
  });
  if (o.stateFile && secret) {
    const id = o.identity();
    writeStateFile(o.stateFile, {
      version: 1,
      pid: process.pid,
      url: served.url,
      token: secret,
      userId: id.userId,
      deviceId: id.deviceId,
      serverVersion: o.version,
      startedAt: new Date().toISOString(),
    });
  }
  o.log?.('info', `${o.version} ready on ${served.url}${secret ? ' (bearer token required)' : ''}`);
  return {
    url: served.url,
    close: async () => {
      // first: no client must find a server that is going
      if (o.stateFile) removeStateFile(o.stateFile, process.pid);
      await served.close();
    },
  };
}
