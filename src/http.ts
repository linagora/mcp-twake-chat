/**
 * Streamable HTTP endpoint with sessions. A session keeps one MCP server per client connection, so a
 * request the server sends to the client in the middle of a tool call (an approval prompt) gets its
 * answer back. Requests without a session (no initialize first) are still served statelessly.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Bearer token required on every request, when set. */
  secret?: string;
  /** Sessions idle longer than this are closed (default 6 hours; the client then initializes again). */
  idleMs?: number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  last: number;
}

const MAX_BODY = 4 * 1024 * 1024;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(s ? JSON.parse(s) : undefined);
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createMcpHttpHandler(newServer: () => McpServer, opts: HttpOptions) {
  const sessions = new Map<string, Session>();
  const idleMs = opts.idleMs ?? 6 * 3600_000;
  const allowedHosts = [`${opts.host}:${opts.port}`, `localhost:${opts.port}`, `127.0.0.1:${opts.port}`];
  const authorized = (req: IncomingMessage) => {
    if (!opts.secret) return true;
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(opts.secret);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.last > idleMs) {
        sessions.delete(id);
        void s.transport.close();
        void s.server.close();
        opts.log?.('debug', `session ${id.slice(0, 8)} closed after ${Math.round(idleMs / 60000)} min idle`);
      }
    }
  }, Math.min(idleMs, 300_000));
  sweep.unref();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
    if (!authorized(req)) return void json(res, 401, { error: 'unauthorized' });
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    try {
      if (sessionId) {
        const s = sessions.get(sessionId);
        if (!s) return void json(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found: initialize again' }, id: null });
        s.last = Date.now();
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        await s.transport.handleRequest(req, res, body);
        if (req.method === 'DELETE') sessions.delete(sessionId);
        return;
      }
      if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
      const body = await readJson(req);
      if (isInitializeRequest(body)) {
        const server = newServer();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server, last: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      // Stateless fallback: one server for this request only (no approval prompt can be answered).
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableDnsRebindingProtection: true, allowedHosts });
      const server = newServer();
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      opts.log?.('error', `request failed: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: (e as Error).message }, id: null });
    }
  };
  return Object.assign(handler, {
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => {});
        await s.server.close().catch(() => {});
      }
      sessions.clear();
    },
  });
}
