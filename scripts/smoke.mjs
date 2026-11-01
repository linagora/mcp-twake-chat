// Live smoke test over stdio, like an MCP client. Prints counts and room names, never message texts.
// Usage: node scripts/smoke.mjs [--draft]   (stop any running server first: one process per device)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['build/index.js'], env: { ...process.env, LOG_LEVEL: 'warn' }, stderr: 'inherit' });
const client = new Client({ name: 'smoke', version: '0' });
const t0 = Date.now();
await client.connect(transport);
const call = async (name, args = {}) => {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return { data: JSON.parse(text), ms: Date.now() - t };
};
const line = (s) => console.log(s);
line(`connected in ${Date.now() - t0} ms; tools: ${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);

const w = await call('whoami');
line(`whoami: ${w.data.user_id} / ${w.data.device_id}, encryption ${JSON.stringify(w.data.encryption)}`);

const all = await call('list_rooms', { limit: 200 });
const kinds = all.data.rooms.reduce((a, r) => ((a[r.kind] = (a[r.kind] ?? 0) + 1), a), {});
line(`list_rooms: ${all.data.total} rooms ${JSON.stringify(kinds)}, ${all.data.rooms.filter((r) => r.encrypted).length} encrypted (${all.ms} ms)`);
const unreadRooms = (await call('list_rooms', { unread_only: true })).data;
line(`list_rooms unread_only: ${unreadRooms.total} rooms with unread messages`);

const u = await call('get_unread', { max_rooms: 10, per_room: 10 });
line(`get_unread (${u.ms} ms):`);
for (const r of u.data.rooms) {
  const k = r.messages.reduce((a, m) => ((a[m.kind] = (a[m.kind] ?? 0) + 1), a), {});
  line(`   ${r.kind.padEnd(5)} ${r.name.slice(0, 40).padEnd(40)} unread returned ${r.unread_messages} ${JSON.stringify(k)}${r.truncated ? ' (truncated)' : ''}`);
}

// a recent encrypted room: decryption rate on 50 messages
const enc = all.data.rooms.find((r) => r.encrypted && r.kind !== 'space' && r.name !== (process.env.MATRIX_DRAFTS_ROOM_NAME ?? 'Drafts'));
const m = await call('get_messages', { room: enc.room_id, limit: 50 });
const und = m.data.messages.filter((x) => x.kind === 'undecryptable').length;
line(`get_messages "${enc.name}": ${m.data.messages.length} messages, ${und} undecryptable, cursor ${m.data.next_cursor ? 'yes' : 'no'} (${m.ms} ms)`);
if (m.data.next_cursor) {
  const m2 = await call('get_messages', { room: enc.room_id, limit: 20, before: m.data.next_cursor });
  const overlap = m2.data.messages.filter((x) => m.data.messages.some((y) => y.id === x.id)).length;
  line(`   next page: ${m2.data.messages.length} messages, ${overlap} duplicates, newest ${m2.data.messages.at(-1)?.time} < oldest of page 1 ${m.data.messages[0]?.time}`);
}
const since = await call('get_messages', { room: enc.room_id, limit: 100, since: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) });
line(`   last 7 days: ${since.data.messages.length} messages`);

const thr = m.data.messages.find((x) => x.thread);
if (thr) {
  const t = await call('get_thread', { room: enc.room_id, thread_id: thr.thread });
  line(`get_thread: ${t.data.messages.length} messages in the thread`);
} else line('get_thread: no thread in this page (not tested)');

const mem = await call('list_room_members', { room: enc.room_id, limit: 500 });
line(`list_room_members: ${mem.data.members.length} members`);

const men = await call('get_mentions', { since: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10) });
line(`get_mentions 7 days: ${men.data.mentions.length} mentions in ${new Set(men.data.mentions.map((x) => x.room.name)).size} rooms (${men.ms} ms)`);

const su = await call('search_users', { query: process.env.SMOKE_USER_QUERY ?? 'admin' });
line(`search_users: ${su.data.users.map((x) => `${x.name} ${x.user_id}${x.dm_room_id ? ' (existing DM)' : ''}`).join(', ')}`);
const p = await call('get_user_profile', { user: su.data.users[0].user_id });
line(`get_user_profile: ${p.data.name}, workplace ${p.data.workplace ?? '-'}`);

const amb = await client.callTool({ name: 'get_room_info', arguments: { room: process.env.SMOKE_ROOM_QUERY ?? 'general' } });
line(`get_room_info (SMOKE_ROOM_QUERY): ${amb.isError ? amb.content[0].text.slice(0, 90) + '…' : 'unique: ' + JSON.parse(amb.content[0].text).name}`);

if (process.argv.includes('--draft')) {
  const d = await call('create_draft', { text: 'mcp-twake-chat smoke test: draft posted in the private drafts room (nothing is sent to anyone).' });
  line(`create_draft: posted in "${d.data.drafts_room}" (${d.data.drafts_room_id}), event ${d.data.event_id}`);
}
await client.close();
line(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
