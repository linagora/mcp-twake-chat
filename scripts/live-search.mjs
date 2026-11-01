// Live test of search and room tools over HTTP. Writes ONLY in LIVE_ROOM (a private room where
// you are alone) and in a throwaway room it creates without inviting anyone, then leaves.
//   LIVE_ROOM=<room id> [LIVE_QUERY=word] node scripts/live-search.mjs
// Prints counts and ids only, never message text.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const room = process.env.LIVE_ROOM;
if (!room) throw new Error('set LIVE_ROOM to the id of a private room where you are the only member');
const url = process.env.MCP_URL ?? 'http://127.0.0.1:3995/mcp';
const token = process.env.MCP_HTTP_TOKEN_FILE ? readFileSync(process.env.MCP_HTTP_TOKEN_FILE, 'utf8').trim() : undefined;
const client = new Client({ name: 'live-search', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const ok = (c, s) => console.log(`${c ? 'ok  ' : 'FAIL'} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if ((await call('list_room_members', { room })).members.length !== 1) throw new Error(`refusing: ${room} has other members`);

// 1. broad search, counts only
const q = process.env.LIVE_QUERY ?? 'demain';
const broad = await call('search_messages', { query: q, limit: 50 });
const allRooms = async () => [...(await call('list_rooms', { kind: 'dm', limit: 200 })).rooms, ...(await call('list_rooms', { kind: 'group', limit: 200 })).rooms];
const enc = new Set((await allRooms()).filter((r) => r.encrypted).map((r) => r.room_id));
const nEnc = broad.results.filter((h) => enc.has(h.room.room_id)).length;
ok(broad.results.length > 0, `search "${q}": ${broad.results.length} hits (${nEnc} in encrypted rooms, ${broad.results.length - nEnc} on the server), newest first: ${broad.results.every((h, i, a) => i === 0 || a[i - 1].time >= h.time)}`);
console.log(`     coverage: ${broad.coverage}`);

// 2. a fresh message in the encrypted private room is found (accents ignored), then forgotten once deleted
const word = `zorglub${Date.now().toString(36)}`;
const sent = await call('send_message', { room, text: `Test de recherche ${word} : réunion déplacée` });
let found;
for (let i = 0; i < 20 && !found; i++) {
  await sleep(500);
  found = (await call('search_messages', { query: `${word} reunion deplacee`, room })).results.find((h) => h.id === sent.event_id);
}
ok(Boolean(found), 'new encrypted message found by the local index (accent-insensitive)');
await call('redact_message', { room, event_id: sent.event_id, reason: 'live test cleanup' });
await sleep(1500);
ok(!(await call('search_messages', { query: word })).results.some((h) => h.id === sent.event_id), 'deleted message no longer found');

// 3. filters
const filtered = await call('search_messages', { query: q, since: '2026-10-01', limit: 20 });
ok(filtered.results.every((h) => h.time >= '2026-10-01'), `since filter: ${filtered.results.length} hits all after 2026-10-01`);

// 4. invitations (read) and a throwaway room
const inv = await call('list_invitations');
ok(Array.isArray(inv.invitations), `list_invitations: ${inv.invitations.length} pending`);
const created = await call('create_room', { name: `mcp-twake-chat test ${new Date().toISOString().slice(11, 19)}`, topic: 'Throwaway room of a live test, left right away.' });
const info = await call('get_room_info', { room: created.room_id });
ok(info.encrypted === true && info.members === 1, `create_room: ${created.room_id} encrypted=${info.encrypted} members=${info.members}`);
await call('leave_room', { room: created.room_id });
await sleep(1500);
const after = { rooms: await allRooms() };
ok(!after.rooms.some((r) => r.room_id === created.room_id), 'leave_room: room gone from list_rooms');
await client.close();
