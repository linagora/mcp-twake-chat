/**
 * The approval prompt (an elicitation request sent by the server during a tool call) must reach the
 * client and its answer must come back over Streamable HTTP: this needs sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
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
