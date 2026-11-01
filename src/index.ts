#!/usr/bin/env node
/**
 * mcp-twake-chat: MCP server for Twake Chat (Matrix), end-to-end encrypted rooms included.
 *
 *   mcp-twake-chat          serve (MCP_TRANSPORT=stdio | http)
 *   mcp-twake-chat check    connect, print identity, encryption and room count, exit
 *
 * Logs go to stderr only (stdout carries JSON-RPC in stdio mode).
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { discover } from './discovery.js';
import { MatrixChat, type Log } from './matrix.js';
import { CommandTokenProvider, StaticTokenProvider, type TokenSource } from './token.js';
import { TomClient } from './tom.js';
import { registerTools } from './tools.js';

const VERSION = '0.2.0';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = LEVELS[(process.env.LOG_LEVEL as keyof typeof LEVELS) ?? 'info'] ?? LEVELS.info;

const log: Log = (level, msg) => {
  if (LEVELS[level] >= threshold) process.stderr.write(`mcp-twake-chat ${level}: ${msg}\n`);
};

// The Matrix SDK logs through console.*: keep stdout clean and drop its chatter unless debugging.
const toStderr = (level: keyof typeof LEVELS) => (...args: unknown[]) => {
  if (LEVELS[level] >= threshold && level !== 'info') process.stderr.write(`${args.map(String).join(' ')}\n`);
};
console.log = toStderr('debug');
console.info = toStderr('debug');
console.debug = toStderr('debug');
console.warn = toStderr(threshold <= LEVELS.debug ? 'warn' : 'debug');
console.error = toStderr('error');

async function main(): Promise<void> {
  const config = loadConfig();
  const tokens: TokenSource =
    config.auth.method === 'command' ? new CommandTokenProvider(config.auth.command) : new StaticTokenProvider(config.auth.accessToken, config.auth.deviceId);
  const endpoints = await discover(config.userId, { homeserverUrl: config.homeserverUrl, tomUrl: config.tomUrl });
  const tom = endpoints.tomUrl ? new TomClient(endpoints.tomUrl, tokens) : undefined;
  const chat = await MatrixChat.open({ config, endpoints, tokens, tom, log, sdkLogLevel: threshold <= LEVELS.debug ? 'debug' : 'error' });

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    await chat.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (process.argv[2] === 'check') {
    const id = chat.identity();
    const rooms = chat.rooms();
    process.stdout.write(
      `${JSON.stringify(
        { user_id: id.userId, device_id: id.deviceId, homeserver: id.homeserverUrl, tom: endpoints.tomUrl, encryption: await chat.encryption(), rooms: rooms.length, encrypted_rooms: rooms.filter((r) => r.encrypted).length },
        null,
        2,
      )}\n`,
    );
    return shutdown();
  }

  const newServer = () => {
    const server = new McpServer({ name: 'mcp-twake-chat', version: VERSION });
    registerTools(server, chat, tom, { timeZone: config.timeZone, downloadDir: config.downloadDir });
    return server;
  };

  if (config.transport.kind === 'stdio') {
    await newServer().connect(new StdioServerTransport());
    log('info', `${VERSION} ready on stdio`);
    return;
  }

  const { host, port, tokenFile } = config.transport;
  const secret = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : undefined;
  const authorized = (req: IncomingMessage) => {
    if (!secret) return true;
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(secret);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const http = createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    // Stateless: one MCP server per request, all sharing the single Matrix device.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`],
    });
    const server = newServer();
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log('error', `request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  http.listen(port, host, () => log('info', `${VERSION} ready on http://${host}:${port}/mcp${secret ? ' (bearer token required)' : ''}`));
}

main().catch((e) => {
  process.stderr.write(`mcp-twake-chat: ${(e as Error).message}\n`);
  process.exit(1);
});
