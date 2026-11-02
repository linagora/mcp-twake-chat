// Live test of the write tools over HTTP, ONLY in a private room whose single member is the user.
//   LIVE_ROOM=<room id> [LIVE_READ_ROOM=<room>] node scripts/live-write.mjs
// Sends a Markdown message, reacts, edits, sends an (encrypted) file, downloads it back and compares
// hashes, then deletes the test message. Optionally downloads one attachment from LIVE_READ_ROOM.
// It answers the approval prompts itself (MCP elicitation): one refusal first (nothing must be sent),
// then accepts. Needs MATRIX_APPROVAL=elicit on the server.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const room = process.env.LIVE_ROOM;
if (!room) throw new Error('set LIVE_ROOM to the id of a private room where you are the only member');
const url = process.env.MCP_URL ?? 'http://127.0.0.1:3995/mcp';
const token = process.env.MCP_HTTP_TOKEN_FILE ? readFileSync(process.env.MCP_HTTP_TOKEN_FILE, 'utf8').trim() : undefined;
const client = new Client({ name: 'live-write', version: '0' }, { capabilities: { elicitation: { form: {} } } });
const answers = [];
const prompts = [];
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  prompts.push(req.params.message);
  const action = answers.shift() ?? 'accept';
  return action === 'accept' ? { action, content: {} } : { action };
});
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const ok = (c, s) => console.log(`${c ? 'ok  ' : 'FAIL'} ${s}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');

const members = (await call('list_room_members', { room })).members;
if (members.length !== 1) throw new Error(`refusing: ${members.length} members in ${room}`);
ok(true, `room ${room} is private (1 member)`);

const stamp = new Date().toISOString().slice(11, 19);
answers.push('decline');
const refused = await client.callTool({ name: 'send_message', arguments: { room, text: `refused ${stamp}` } });
const before = (await call('get_messages', { room, limit: 5 })).messages;
ok(/^Not done: the user refused/.test(refused.content[0].text) && !before.some((m) => m.text?.includes(`refused ${stamp}`)), 'send_message refused: nothing sent');
console.log('--- prompt of the refused message ---\n' + prompts[0] + '\n---');
const sent = await call('send_message', { room, text: `**live test ${stamp}** · a list:\n- one\n- two` });
let page = (await call('get_messages', { room, limit: 5 })).messages;
const mine = page.find((m) => m.id === sent.event_id);
ok(mine?.text?.includes(`live test ${stamp}`), 'send_message: message read back (decrypted)');

await call('react', { room, event_id: sent.event_id, emoji: '👍' });
ok(true, 'react: reaction sent');

await call('edit_message', { room, event_id: sent.event_id, text: `live test ${stamp} (edited)` });
page = (await call('get_messages', { room, limit: 10 })).messages;
const edited = page.find((m) => m.id === sent.event_id);
ok(edited?.edited && edited.text === `live test ${stamp} (edited)`, 'edit_message: edit applied when reading');

// send_file only reads inside the upload folder, download_attachment only writes inside the download folder
const dir = mkdtempSync(join(process.env.MATRIX_UPLOAD_DIR ?? process.env.MATRIX_DOWNLOAD_DIR ?? tmpdir(), 'live-write-'));
const local = join(dir, `sample-${stamp.replace(/:/g, '')}.txt`);
const bytes = Buffer.concat([Buffer.from('mcp-twake-chat live test\n'), randomBytes(4096)]);
writeFileSync(local, bytes);
const f = await call('send_file', { room, path: local, caption: 'live test file' });
ok(f.encrypted, `send_file: uploaded ${f.size} bytes, encrypted=${f.encrypted}`);
const back = await call('download_attachment', { room, event_id: f.event_id, save_dir: join(process.env.MATRIX_DOWNLOAD_DIR ?? dir, 'live-write-in') });
ok(sha(readFileSync(back.path)) === sha(bytes), `download_attachment: decrypted copy identical (${back.size} bytes)`);

await call('redact_message', { room, event_id: sent.event_id, reason: 'live test cleanup' });
await call('redact_message', { room, event_id: f.event_id, reason: 'live test cleanup' });
page = (await call('get_messages', { room, limit: 10 })).messages;
ok(page.find((m) => m.id === sent.event_id)?.kind === 'deleted', 'redact_message: test message deleted');

if (process.env.LIVE_READ_ROOM) {
  const msgs = (await call('get_messages', { room: process.env.LIVE_READ_ROOM, limit: 100 })).messages;
  const att = [...msgs].reverse().find((m) => m.attachment?.url || m.attachment?.encrypted);
  if (att) {
    const d = await call('download_attachment', { room: process.env.LIVE_READ_ROOM, event_id: att.id, save_dir: join(process.env.MATRIX_DOWNLOAD_DIR ?? dir, 'live-write-read') });
    ok(d.size > 0, `download_attachment (read-only room): ${d.size} bytes, ${d.mimetype ?? '?'}`);
  } else console.log('skip download in LIVE_READ_ROOM: no attachment in the last 100 messages');
}
rmSync(dir, { recursive: true, force: true });
if (process.env.MATRIX_DOWNLOAD_DIR) rmSync(join(process.env.MATRIX_DOWNLOAD_DIR, 'live-write-in'), { recursive: true, force: true });
const refs = prompts.map((p) => /(?:Ref\.|Réf\.) (\w+)/.exec(p)?.[1]);
ok(new Set(refs).size === prompts.length, `${prompts.length} approval prompts, each with its own reference`);
await client.close();
