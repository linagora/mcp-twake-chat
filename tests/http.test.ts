/**
 * The approval prompt (an elicitation request sent by the server during a tool call) must reach the
 * client and its answer must come back over Streamable HTTP: this needs sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Approver, NotApproved } from '../src/approval.js';
import { createMcpHttpHandler } from '../src/http.js';

const done: string[] = [];
let http: HttpServer;
let handler: ReturnType<typeof createMcpHttpHandler>;
let url: URL;

const newServer = () => {
  const server = new McpServer({ name: 't', version: '0' });
  const approver = new Approver(server.server, { mode: 'elicit', language: 'en', timeoutMs: 5000, as: 'Me' });
  server.registerTool('send_message', { inputSchema: { text: z.string() } }, async (a: { text: string }) => {
    try {
      await approver.confirm({ action: 'send_message', details: [['text', a.text]] });
    } catch (e) {
      return { content: [{ type: 'text' as const, text: e instanceof NotApproved ? `refused (${e.outcome})` : `error: ${(e as Error).message}` }] };
    }
    done.push(a.text);
    return { content: [{ type: 'text' as const, text: 'sent' }] };
  });
  return server;
};

beforeAll(async () => {
  http = createServer();
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  handler = createMcpHttpHandler(newServer, { host: '127.0.0.1', port, secret: 's3cret' });
  http.on('request', (req, res) => void handler(req, res));
  url = new URL(`http://127.0.0.1:${port}/mcp`);
});

afterAll(async () => {
  await handler.close();
  await new Promise((r) => http.close(r));
});

async function connect(answer: 'accept' | 'decline', capabilities = { elicitation: { form: {} } }) {
  const client = new Client({ name: 'c', version: '0' }, { capabilities });
  const prompts: string[] = [];
  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return answer === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
    });
  }
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer s3cret' } } }));
  return { client, prompts };
}

const call = async (c: Client, text: string) => ((await c.callTool({ name: 'send_message', arguments: { text } })).content as { text: string }[])[0].text;

describe('approval over Streamable HTTP', () => {
  it('asks the client during the call and acts on accept', async () => {
    const { client, prompts } = await connect('accept');
    expect(await call(client, 'hello')).toBe('sent');
    expect(prompts[0]).toMatch(/^Twake Chat: Send a message\nAs: Me \(your account\)\nText: hello/);
    expect(done).toEqual(['hello']);
    await client.close();
  });

  it('does nothing on refusal, and two clients get their own prompts', async () => {
    const a = await connect('decline');
    const b = await connect('accept');
    const [ra, rb] = await Promise.all([call(a.client, 'from a'), call(b.client, 'from b')]);
    expect(ra).toBe('refused (decline)');
    expect(rb).toBe('sent');
    expect(a.prompts).toHaveLength(1);
    expect(b.prompts).toHaveLength(1);
    expect(done).toEqual(['hello', 'from b']);
    expect(handler.sessions()).toBeGreaterThanOrEqual(2);
    await a.client.close();
    await b.client.close();
  });

  it('rejects requests without the bearer token', async () => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('answers an unknown session with 404 so the client initializes again', async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret', 'mcp-session-id': 'nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.status).toBe(404);
  });
});

describe('shared mode: shutdown route and idle exit', () => {
  async function serve(extra: Partial<Parameters<typeof createMcpHttpHandler>[1]>) {
    const h = createServer();
    await new Promise<void>((r) => h.listen(0, '127.0.0.1', r));
    const port = (h.address() as AddressInfo).port;
    const handlerOf = createMcpHttpHandler(newServer, { host: '127.0.0.1', port, secret: 's3cret', ...extra });
    h.on('request', (req, res) => void handlerOf(req, res));
    return {
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      handlerOf,
      close: async () => {
        await handlerOf.close();
        await new Promise((r) => h.close(r));
      },
    };
  }

  /** fetch() cannot set Host: a raw request as a page of another site (DNS rebinding) would send it */
  function postWithHost(port: number, path: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { host, authorization: 'Bearer s3cret' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('stops on POST /mcp/shutdown with the token, refuses it without', async () => {
    let stopped = 0;
    const s = await serve({ onShutdown: () => void stopped++ });
    expect((await fetch(`${s.url}/shutdown`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${s.url}/shutdown`, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(`${s.url}/shutdown`, { method: 'GET', headers: { authorization: 'Bearer s3cret' } })).status).toBe(405);
    expect(stopped).toBe(0);
    expect((await fetch(`${s.url}/shutdown`, { method: 'POST', headers: { authorization: 'Bearer s3cret' } })).status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(1);
    await s.close();
  });

  it('refuses the shutdown route on another host, as the rest', async () => {
    let stopped = 0;
    const s = await serve({ onShutdown: () => void stopped++ });
    expect(await postWithHost(s.port, '/mcp/shutdown', 'evil.example.com')).toBe(403);
    expect(await postWithHost(s.port, '/mcp/shutdown', `evil.example.com:${s.port}`)).toBe(403);
    expect(stopped).toBe(0);
    expect(await postWithHost(s.port, '/mcp/shutdown', `localhost:${s.port}`)).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(1);
    await s.close();
  });

  /** a raw request with the headers a browser page would send */
  function rawRequest(port: number, path: string, headers: Record<string, string>, method = 'POST'): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('has no shutdown route without a token', async () => {
    let stopped = 0;
    const s = await serve({ secret: undefined, onShutdown: () => void stopped++ });
    expect(await rawRequest(s.port, '/mcp/shutdown', { host: `127.0.0.1:${s.port}` })).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(0);
    await s.close();
  });

  it('refuses a shutdown sent by a web page (an Origin header)', async () => {
    let stopped = 0;
    const s = await serve({ onShutdown: () => void stopped++ });
    expect(await rawRequest(s.port, '/mcp/shutdown', { host: `127.0.0.1:${s.port}`, authorization: 'Bearer s3cret', origin: 'https://evil.example' })).toBe(403);
    expect(await rawRequest(s.port, '/mcp/shutdown', { host: `127.0.0.1:${s.port}`, authorization: 'Bearer s3cret', origin: 'null' })).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(0);
    expect(await rawRequest(s.port, '/mcp/shutdown', { host: `127.0.0.1:${s.port}`, authorization: 'Bearer s3cret' })).toBe(202);
    await s.close();
  });

  it('refuses another host before any route, the token checked or not', async () => {
    const s = await serve({});
    expect(await rawRequest(s.port, '/mcp', { host: `evil.example.com:${s.port}` })).toBe(403);
    expect(await rawRequest(s.port, '/mcp/shutdown', { host: `evil.example.com:${s.port}` })).toBe(403);
    expect(await rawRequest(s.port, '/mcp', { host: `evil.example.com:${s.port}`, authorization: 'Bearer s3cret' })).toBe(403);
    const open = await serve({ secret: undefined });
    expect(await rawRequest(open.port, '/mcp', { host: `evil.example.com:${open.port}` })).toBe(403);
    await open.close();
    await s.close();
  });

  it('exits once no session has been open for the idle delay, a ping without session not counting', async () => {
    let idle = 0;
    const s = await serve({ exitWhenIdleMs: 300, onIdle: () => void idle++ });
    // a ping without a session (as a client checking the server does)
    await fetch(s.url, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(idle).toBe(1);
    await s.close();
  });

  it('does not exit while a session is open, and counts the delay again once it closes', async () => {
    let idle = 0;
    const s = await serve({ exitWhenIdleMs: 300, onIdle: () => void idle++ });
    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { authorization: 'Bearer s3cret' } } });
    await client.connect(transport);
    await new Promise((r) => setTimeout(r, 600));
    expect(idle).toBe(0);
    await transport.terminateSession();
    await client.close();
    await new Promise((r) => setTimeout(r, 600));
    expect(idle).toBe(1);
    await s.close();
  });
});
