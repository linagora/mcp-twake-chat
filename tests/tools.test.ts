import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools, parseWhen } from '../src/tools.js';
import type { ChatService, Directory, MessageQuery, NewRoom, SearchRequest } from '../src/service.js';
import type { MessageView, RoomView } from '../src/format.js';

const T = (h: number, m = 0) => Date.UTC(2026, 10, 1, h, m);
const room = (over: Partial<RoomView>): RoomView => ({ id: '!r:x', name: 'Room', kind: 'group', encrypted: true, members: 3, unread: false, notifications: 0, highlights: 0, lastActivity: T(6), ...over });
const msg = (over: Partial<MessageView>): MessageView => ({ id: '$m', sender: '@bob:x', senderName: 'Bob', ts: T(6), kind: 'text', body: 'hi', ...over });

const ROOMS = [
  room({ id: '!dm:x', name: 'Alice MARTIN', kind: 'dm', dmUserId: '@az:x', members: 2, unread: true, notifications: 2, highlights: 1, lastActivity: T(7) }),
  room({ id: '!t:x', name: 'Équipe Twake', lastActivity: T(5) }),
  room({ id: '!t2:x', name: 'Twake Chat support', encrypted: false, unread: true, lastActivity: T(4) }),
];

class FakeChat implements ChatService {
  queries: { roomId: string; q: MessageQuery }[] = [];
  drafts: { text: string; target?: RoomView }[] = [];
  identity() {
    return { userId: '@me:x', deviceId: 'DEV', displayName: 'Me', homeserverUrl: 'https://matrix.x' };
  }
  async encryption() {
    return { crossSigningReady: true, deviceVerified: true, keyBackupVersion: '4' };
  }
  rooms() {
    return ROOMS;
  }
  async members() {
    return [{ userId: '@az:x', name: 'Alice', membership: 'join' }];
  }
  async messages(roomId: string, q: MessageQuery) {
    this.queries.push({ roomId, q });
    return { messages: [msg({ id: '$1', ts: T(6, 1), body: 'one', replyTo: '$0' }), msg({ id: '$2', ts: T(6, 2), kind: 'undecryptable', body: '[encrypted message: no key on this device (X)]' })], next: 'cursor2' };
  }
  async message(_roomId: string, eventId: string) {
    return eventId === '$gone' ? undefined : msg({ id: eventId, body: 'le contrat est prêt', ts: T(8, 5) });
  }
  async thread() {
    return [msg({ id: '$root' }), msg({ id: '$r1', threadRoot: '$root' })];
  }
  async unread(perRoom: number, maxRooms: number, kind?: RoomView['kind']) {
    return ROOMS.filter((r) => r.unread && (!kind || r.kind === kind))
      .slice(0, maxRooms)
      .map((r) => ({ room: r, messages: [msg({ id: `$u-${r.id}` }), msg({ id: `$v-${r.id}` })].slice(0, perRoom), truncated: perRoom < 2 }));
  }
  async mentions(sinceMs: number) {
    return sinceMs < T(6) ? [{ room: ROOMS[0], message: msg({ id: '$men', mentionsMe: true, body: '@me look' }) }] : [];
  }
  async postDraft(text: string, target?: RoomView) {
    this.drafts.push({ text, target });
    return { roomId: '!drafts:x', roomName: 'Drafts', eventId: '$d1' };
  }
  writes: unknown[][] = [];
  async sendMessage(roomId: string, text: string, opts: object) {
    this.writes.push(['send', roomId, text, opts]);
    return { eventId: '$s1' };
  }
  async react(roomId: string, eventId: string, key: string) {
    this.writes.push(['react', roomId, eventId, key]);
    return { eventId: '$r1' };
  }
  async editMessage(roomId: string, eventId: string, text: string) {
    this.writes.push(['edit', roomId, eventId, text]);
    return { eventId: '$e1' };
  }
  async redactMessage(roomId: string, eventId: string, reason?: string) {
    this.writes.push(['redact', roomId, eventId, reason]);
    return { eventId: '$x1' };
  }
  async sendFile(roomId: string, file: { path: string; name?: string; caption?: string }) {
    this.writes.push(['file', roomId, file]);
    return { eventId: '$f1', name: 'report.pdf', size: 1234, encrypted: true };
  }
  searches: SearchRequest[] = [];
  async searchMessages(q: SearchRequest) {
    this.searches.push(q);
    return {
      hits: [{ id: '$h1', roomId: '!t:x', roomName: 'Équipe Twake', sender: '@bob:x', senderName: 'Bob', ts: T(6, 30), body: 'le contrat est signé', threadRoot: '$root' }],
      index: { messages: 1200, rooms: 40, completeRooms: 12, backfilling: true },
      serverRooms: 1,
    };
  }
  invitations() {
    return [{ roomId: '!inv:x', name: 'Projet Atlas', inviter: '@bob:x', inviterName: 'Bob DURAND', ts: T(5), direct: false }];
  }
  async joinRoom(idOrAlias: string) {
    this.writes.push(['join', idOrAlias]);
    return { roomId: '!inv:x', name: 'Projet Atlas' };
  }
  async leaveRoom(roomId: string) {
    this.writes.push(['leave', roomId]);
  }
  async createRoom(r: NewRoom) {
    this.writes.push(['create', r]);
    return { roomId: '!new:x' };
  }
  async invite(roomId: string, userId: string) {
    this.writes.push(['invite', roomId, userId]);
  }
  async downloadAttachment(roomId: string, eventId: string, dir: string) {
    this.writes.push(['download', roomId, eventId, dir]);
    return { path: `${dir}/report.pdf`, name: 'report.pdf', mimetype: 'application/pdf', size: 1234 };
  }
}

const directory: Directory = {
  async searchUsers(q) {
    return q === 'durand' ? [{ userId: '@bdurand:x', displayName: 'Bob DURAND', emails: [], phones: [], active: true }] : [];
  },
  async userInfo(id) {
    return id === '@bdurand:x' ? { userId: id, displayName: 'Bob DURAND', emails: ['g@x'], phones: [] } : null;
  },
};

let chat: FakeChat;
let prompts: string[] = [];
/** A client that shows approval prompts (MCP elicitation) and accepts them. */
function approvingClient(answer: () => 'accept' | 'decline' | 'cancel' = () => 'accept'): Client {
  const c = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  c.setRequestHandler(ElicitRequestSchema, async (req) => {
    prompts.push(req.params.message);
    const action = answer();
    return action === 'accept' ? { action, content: {} } : { action };
  });
  return c;
}
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0].text;
  return { isError: Boolean(res.isError), text, data: res.isError ? undefined : JSON.parse(text) };
}

beforeEach(async () => {
  prompts = [];
  chat = new FakeChat();
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, chat, directory, { timeZone: 'Europe/Paris', downloadDir: '/tmp/dl' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = approvingClient();
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe('tool catalogue', () => {
  it('exposes read tools as read-only and the draft tool as closed-world', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    const WRITE = ['send_message', 'react', 'edit_message', 'redact_message', 'send_file', 'join_room', 'leave_room', 'create_room', 'invite_user'];
    expect(Object.keys(by).sort()).toEqual(
      ['create_draft', 'download_attachment', 'get_mentions', 'get_messages', 'get_room_info', 'get_thread', 'get_unread', 'get_user_profile', 'list_invitations', 'list_room_members', 'list_rooms', 'search_messages', 'search_users', 'whoami', ...WRITE].sort(),
    );
    for (const name of Object.keys(by).filter((n) => n !== 'create_draft' && !WRITE.includes(n))) expect(by[name].annotations?.readOnlyHint).toBe(true);
    expect(by.create_draft.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    for (const name of WRITE) {
      expect(by[name].annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      expect(by[name].description).toMatch(/in the user's name/);
    }
    expect(by.redact_message.annotations?.destructiveHint).toBe(true);
    expect(by.leave_room.annotations?.destructiveHint).toBe(true);
    expect(by.send_message.annotations?.destructiveHint).toBe(false);
    expect(by.get_messages.description).toMatch(/untrusted|instructions/i);
  });
});

describe('rooms', () => {
  it('lists rooms by recent activity with filters', async () => {
    const all = (await call('list_rooms')).data;
    expect(all.total).toBe(3);
    expect(all.rooms.map((r: { name: string }) => r.name)).toEqual(['Alice MARTIN', 'Équipe Twake', 'Twake Chat support']);
    expect(all.rooms[0]).toMatchObject({ room_id: '!dm:x', kind: 'dm', with: '@az:x', unread: true, notifications: 2, mentions: 1, last_activity: '2026-11-01 08:00' });
    expect((await call('list_rooms', { kind: 'dm' })).data.rooms).toHaveLength(1);
    expect((await call('list_rooms', { unread_only: true })).data.rooms.map((r: { room_id: string }) => r.room_id)).toEqual(['!dm:x', '!t2:x']);
    expect((await call('list_rooms', { query: 'twake' })).data.rooms).toHaveLength(2);
  });

  it('resolves a room by name and reports ambiguity', async () => {
    const info = await call('get_room_info', { room: 'martin' });
    expect(info.data).toMatchObject({ room_id: '!dm:x', name: 'Alice MARTIN', encrypted: true });
    const amb = await call('get_room_info', { room: 'twake' });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/2 rooms match.*Équipe Twake.*Twake Chat support/s);
    const none = await call('get_room_info', { room: 'nope' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/No room matches "nope"/);
  });

  it('lists members', async () => {
    expect((await call('list_room_members', { room: '!dm:x' })).data.members).toEqual([{ user_id: '@az:x', name: 'Alice', membership: 'join' }]);
  });
});

describe('messages', () => {
  it('returns messages with local times, flags and a cursor', async () => {
    const r = (await call('get_messages', { room: 'Équipe Twake', limit: 10, since: '2026-11-01' })).data;
    expect(r.room).toEqual({ room_id: '!t:x', name: 'Équipe Twake' });
    expect(r.messages[0]).toEqual({ id: '$1', time: '2026-11-01 07:01', from: 'Bob', from_id: '@bob:x', kind: 'text', text: 'one', reply_to: '$0' });
    expect(r.messages[1]).toMatchObject({ kind: 'undecryptable' });
    expect(r.next_cursor).toBe('cursor2');
    expect(chat.queries[0]).toEqual({ roomId: '!t:x', q: { limit: 10, since: Date.UTC(2026, 9, 31, 23, 0) } });
  });

  it('caps the page size', async () => {
    await call('get_messages', { room: '!t:x', limit: 1000 });
    expect(chat.queries[0].q.limit).toBe(100);
  });

  it('reads a thread', async () => {
    expect((await call('get_thread', { room: '!t:x', thread_id: '$root' })).data.messages.map((m: { id: string }) => m.id)).toEqual(['$root', '$r1']);
  });

  it('summarises unread rooms and mentions', async () => {
    const u = (await call('get_unread')).data;
    expect(u.rooms.map((r: { room_id: string }) => r.room_id)).toEqual(['!dm:x', '!t2:x']);
    expect(u.rooms[1]).toMatchObject({ unread_messages: 2, truncated: false });
    expect((await call('get_unread', { per_room: 1 })).data.rooms[0]).toMatchObject({ unread_messages: 1, truncated: true });
    const m = (await call('get_mentions', { since: '2026-11-01T06:00' })).data;
    expect(m.mentions[0]).toMatchObject({ room: { room_id: '!dm:x', name: 'Alice MARTIN' }, id: '$men', text: '@me look' });
  });
});

describe('people', () => {
  it('searches the directory and reads profiles', async () => {
    expect((await call('search_users', { query: 'durand' })).data.users[0]).toMatchObject({ user_id: '@bdurand:x', name: 'Bob DURAND' });
    expect((await call('get_user_profile', { user: '@bdurand:x' })).data).toMatchObject({ user_id: '@bdurand:x', emails: ['g@x'] });
    expect((await call('get_user_profile', { user: '@nobody:x' })).isError).toBe(true);
  });

  it('reports identity and encryption', async () => {
    expect((await call('whoami')).data).toMatchObject({ user_id: '@me:x', device_id: 'DEV', encryption: { deviceVerified: true } });
  });
});

describe('drafts', () => {
  it('posts the draft in the drafts room with its target, never in the target room', async () => {
    const r = (await call('create_draft', { text: 'Bonjour Alice', room: 'martin' })).data;
    expect(chat.drafts).toEqual([{ text: 'Bonjour Alice', target: ROOMS[0] }]);
    expect(r).toMatchObject({ drafts_room: 'Drafts', for_room: 'Alice MARTIN', event_id: '$d1' });
    await call('create_draft', { text: 'note' });
    expect(chat.drafts[1]).toEqual({ text: 'note', target: undefined });
  });
});

describe('write tools (v0.2)', () => {
  it('sends a message with reply, thread and mentions to the resolved room', async () => {
    const r = (await call('send_message', { room: 'martin', text: 'OK pour mardi', reply_to: '$q', thread_id: '$root', mention_users: ['@amartin:x'] })).data;
    expect(chat.writes[0]).toEqual(['send', '!dm:x', 'OK pour mardi', { replyTo: '$q', threadRoot: '$root', mentions: ['@amartin:x'] }]);
    expect(r).toMatchObject({ room: { room_id: '!dm:x', name: 'Alice MARTIN' }, event_id: '$s1' });
  });

  it('reacts, edits and redacts', async () => {
    await call('react', { room: '!t:x', event_id: '$m', emoji: '👍' });
    await call('edit_message', { room: '!t:x', event_id: '$m', text: 'fixed' });
    await call('redact_message', { room: '!t:x', event_id: '$m', reason: 'typo' });
    expect(chat.writes).toEqual([
      ['react', '!t:x', '$m', '👍'],
      ['edit', '!t:x', '$m', 'fixed'],
      ['redact', '!t:x', '$m', 'typo'],
    ]);
  });

  it('sends a local file given by absolute path only', async () => {
    expect((await call('send_file', { room: '!t:x', path: 'relative.pdf' })).isError).toBe(true);
    const r = (await call('send_file', { room: '!t:x', path: '/tmp/report.pdf', caption: 'v2' })).data;
    expect(chat.writes.at(-1)).toEqual(['file', '!t:x', { path: '/tmp/report.pdf', caption: 'v2' }]);
    expect(r).toMatchObject({ event_id: '$f1', name: 'report.pdf', encrypted: true });
  });

  it('downloads an attachment to the default or given directory', async () => {
    expect((await call('download_attachment', { room: '!t:x', event_id: '$m' })).data).toMatchObject({ path: '/tmp/dl/report.pdf', size: 1234 });
    await call('download_attachment', { room: '!t:x', event_id: '$m', save_dir: '/srv/in' });
    expect(chat.writes.at(-1)).toEqual(['download', '!t:x', '$m', '/srv/in']);
    expect((await call('download_attachment', { room: '!t:x', event_id: '$m', save_dir: 'rel' })).isError).toBe(true);
  });
});

describe('MATRIX_SEND_SCOPE=dm', () => {
  it('refuses to write in group rooms but allows direct messages', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    const c2 = new FakeChat();
    registerTools(server, c2, directory, { timeZone: 'Europe/Paris', sendScope: 'dm' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const cl = approvingClient();
    await cl.connect(ct);
    const call2 = async (name: string, args: Record<string, unknown>) => cl.callTool({ name, arguments: args });
    const group = await call2('send_message', { room: '!t:x', text: 'hello' });
    expect(group.isError).toBe(true);
    expect((group.content as { text: string }[])[0].text).toMatch(/direct messages only/);
    for (const [name, args] of [
      ['react', { room: '!t:x', event_id: '$m', emoji: '👍' }],
      ['edit_message', { room: '!t:x', event_id: '$m', text: 'x' }],
      ['redact_message', { room: '!t:x', event_id: '$m' }],
      ['send_file', { room: '!t:x', path: '/tmp/a.pdf' }],
    ] as const) expect((await call2(name, args)).isError).toBe(true);
    expect((await call2('send_message', { room: '!dm:x', text: 'hello' })).isError).toBeFalsy();
    expect(c2.writes).toEqual([['send', '!dm:x', 'hello', {}]]);
    const tools = (await cl.listTools()).tools;
    expect(tools.find((x) => x.name === 'send_message')?.description).toMatch(/direct messages only/);
  });
});

describe('v0.3: search and rooms', () => {
  it('searches messages with room, sender and date filters and reports the index coverage', async () => {
    const r = (await call('search_messages', { query: 'contrat signé', room: 'équipe', from: '@bob:x', since: '2026-10-01', until: '2026-11-01', limit: 5 })).data;
    expect(chat.searches[0]).toEqual({ text: 'contrat signé', roomIds: ['!t:x'], sender: '@bob:x', since: parseWhen('2026-10-01', 'Europe/Paris'), until: parseWhen('2026-11-01', 'Europe/Paris'), limit: 5 });
    expect(r.results[0]).toMatchObject({ room: { room_id: '!t:x', name: 'Équipe Twake' }, id: '$h1', from: 'Bob', from_id: '@bob:x', text: 'le contrat est signé', thread: '$root' });
    expect(r.results[0].time).toMatch(/2026-11-01/);
    expect(r.coverage).toMatch(/12\/40/);
    expect(r.coverage).toMatch(/still indexing/);
    expect((await call('search_messages', { query: '  ' })).isError).toBe(true);
  });

  it('lists invitations and joins one by name', async () => {
    expect((await call('list_invitations')).data.invitations[0]).toMatchObject({ room_id: '!inv:x', name: 'Projet Atlas', invited_by: 'Bob DURAND', invited_by_id: '@bob:x' });
    expect((await call('join_room', { room: 'atlas' })).data).toMatchObject({ room_id: '!inv:x', name: 'Projet Atlas' });
    await call('join_room', { room: '#public:x' });
    expect(chat.writes).toEqual([['join', '!inv:x'], ['join', '#public:x']]);
    expect((await call('join_room', { room: 'nothing like this' })).isError).toBe(true);
  });

  it('leaves, creates and invites', async () => {
    await call('leave_room', { room: 'twake chat support' });
    const created = (await call('create_room', { name: 'Atlas', invite: ['@bob:x'] })).data;
    await call('create_room', { direct_with: '@carol:x' });
    await call('invite_user', { room: '!t:x', user_id: '@carol:x' });
    expect(created).toMatchObject({ room_id: '!new:x' });
    expect(chat.writes).toEqual([
      ['leave', '!t2:x'],
      ['create', { name: 'Atlas', invite: ['@bob:x'], encrypted: true, direct: false }],
      ['create', { invite: ['@carol:x'], encrypted: true, direct: true }],
      ['invite', '!t:x', '@carol:x'],
    ]);
    expect((await call('create_room', {})).isError).toBe(true);
    expect((await call('invite_user', { room: '!t:x', user_id: 'carol' })).isError).toBe(true);
  });
});

describe('parseWhen', () => {
  it('reads dates as local midnight and datetimes in the user zone', () => {
    expect(parseWhen('2026-07-01', 'Europe/Paris')).toBe(Date.UTC(2026, 5, 30, 22, 0));
    expect(parseWhen('2026-11-01T06:00', 'Europe/Paris')).toBe(Date.UTC(2026, 10, 1, 5, 0));
    expect(parseWhen('2026-11-01T06:00:00Z', 'Europe/Paris')).toBe(Date.UTC(2026, 10, 1, 6, 0));
    expect(() => parseWhen('tomorrow', 'Europe/Paris')).toThrow(/date/);
  });
});

describe('v0.5: prior approval of every action in the user name', () => {
  const WRITES: [string, Record<string, unknown>, string][] = [
    ['send_message', { room: '!t:x', text: 'Bonjour à tous', reply_to: '$m1' }, 'send'],
    ['react', { room: '!t:x', event_id: '$m1', emoji: '👍' }, 'react'],
    ['edit_message', { room: '!dm:x', event_id: '$m1', text: 'corrigé' }, 'edit'],
    ['redact_message', { room: '!dm:x', event_id: '$m1' }, 'redact'],
    ['send_file', { room: '!t:x', path: '/tmp/does-not-exist.pdf' }, 'file'],
    ['join_room', { room: '#public:x' }, 'join'],
    ['leave_room', { room: '!t2:x' }, 'leave'],
    ['create_room', { name: 'Projet X', invite: ['@bob:x'] }, 'create'],
    ['invite_user', { room: '!t:x', user_id: '@bob:x' }, 'invite'],
  ];

  async function connect(answer: () => 'accept' | 'decline' | 'cancel', opts: { elicitation?: boolean; mode?: 'elicit' | 'client' } = {}) {
    const c = new FakeChat();
    const server = new McpServer({ name: 't', version: '0' });
    registerTools(server, c, directory, { timeZone: 'Europe/Paris', approval: { mode: opts.mode ?? 'elicit', language: 'fr', timeoutMs: 2000 } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const cl = opts.elicitation === false ? new Client({ name: 'c', version: '0' }) : approvingClient(answer);
    await cl.connect(ct);
    const callIt = async (name: string, args: Record<string, unknown>) => {
      const r = (await cl.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { isError: Boolean(r.isError), text: r.content[0].text };
    };
    return { c, callIt };
  }

  it.each(WRITES)('%s acts only after the user accepts', async (tool, args, kind) => {
    const ok = await connect(() => 'accept');
    await ok.callIt(tool, args);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^Twake Chat : .+\nEn tant que : Me \(@me:x\) \(votre compte\)\n/);
    expect(prompts[0]).toMatch(/Réf\. [0-9a-f]{6} · Acceptez/);
    expect(ok.c.writes.map((w) => w[0])).toEqual([kind]);
    for (const answer of ['decline', 'cancel'] as const) {
      const no = await connect(() => answer);
      const r = await no.callIt(tool, args);
      expect(r.text).toMatch(/^Not done: .*nothing was sent or changed/);
      expect(no.c.writes).toEqual([]);
    }
  });

  it('shows the room kind, the quoted message and the exact text, in group rooms too', async () => {
    const t = await connect(() => 'accept');
    await t.callIt('send_message', { room: '!t:x', text: 'Bonjour à tous\nà demain', reply_to: '$m1', mention_users: ['@bob:x'] });
    expect(prompts[0]).toContain('Salon : Équipe Twake (salon de groupe, 3 membres, chiffré de bout en bout)');
    expect(prompts[0]).toContain('En réponse à : Bob, 2026-11-01 09:05 : « le contrat est prêt »');
    expect(prompts[0]).toContain('Notifie : @bob:x');
    expect(prompts[0]).toContain('Texte : \nBonjour à tous\nà demain');
    await t.callIt('react', { room: '!dm:x', event_id: '$gone', emoji: '🎉' });
    expect(prompts[1]).toContain('Salon : Alice MARTIN (message direct, chiffré de bout en bout) · @az:x');
    expect(prompts[1]).toContain('Message : $gone');
    expect(new Set(prompts.map((p) => /Réf\. (\w+)/.exec(p)![1])).size).toBe(2);
  });

  it('refuses to act when the client cannot ask, unless the client confirms itself', async () => {
    const blind = await connect(() => 'accept', { elicitation: false });
    const r = await blind.callIt('send_message', { room: '!dm:x', text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot ask the user for approval/);
    expect(blind.c.writes).toEqual([]);
    const client = await connect(() => 'accept', { elicitation: false, mode: 'client' });
    expect((await client.callIt('send_message', { room: '!dm:x', text: 'x' })).isError).toBe(false);
    expect(client.c.writes).toHaveLength(1);
  });

  it('never asks for reads or drafts', async () => {
    const t = await connect(() => 'decline');
    await t.callIt('list_rooms', {});
    await t.callIt('get_messages', { room: '!t:x' });
    await t.callIt('create_draft', { text: 'brouillon', room: '!t:x' });
    expect(prompts).toEqual([]);
    expect(t.c.drafts).toHaveLength(1);
  });
});
