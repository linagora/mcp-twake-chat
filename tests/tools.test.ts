import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, parseWhen } from '../src/tools.js';
import type { ChatService, Directory, MessageQuery } from '../src/service.js';
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
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0].text;
  return { isError: Boolean(res.isError), text, data: res.isError ? undefined : JSON.parse(text) };
}

beforeEach(async () => {
  chat = new FakeChat();
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, chat, directory, { timeZone: 'Europe/Paris' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe('tool catalogue', () => {
  it('exposes read tools as read-only and the draft tool as closed-world', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual(
      ['create_draft', 'get_mentions', 'get_messages', 'get_room_info', 'get_thread', 'get_unread', 'get_user_profile', 'list_room_members', 'list_rooms', 'search_users', 'whoami'].sort(),
    );
    for (const name of Object.keys(by).filter((n) => n !== 'create_draft')) expect(by[name].annotations?.readOnlyHint).toBe(true);
    expect(by.create_draft.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
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

describe('parseWhen', () => {
  it('reads dates as local midnight and datetimes in the user zone', () => {
    expect(parseWhen('2026-07-01', 'Europe/Paris')).toBe(Date.UTC(2026, 5, 30, 22, 0));
    expect(parseWhen('2026-11-01T06:00', 'Europe/Paris')).toBe(Date.UTC(2026, 10, 1, 5, 0));
    expect(parseWhen('2026-11-01T06:00:00Z', 'Europe/Paris')).toBe(Date.UTC(2026, 10, 1, 6, 0));
    expect(() => parseWhen('tomorrow', 'Europe/Paris')).toThrow(/date/);
  });
});
