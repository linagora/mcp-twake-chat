import { describe, expect, it } from 'vitest';
import { applyEdits, fold, formatTime, matchRooms, messageFromEvent, stripReplyFallback, type RawEvent, type RoomView } from '../src/format.js';

const ev = (over: Partial<RawEvent> & { content?: Record<string, unknown> }): RawEvent => ({
  event_id: '$e1',
  room_id: '!r:x',
  sender: '@bob:x',
  type: 'm.room.message',
  origin_server_ts: Date.UTC(2026, 10, 1, 6, 5),
  content: { msgtype: 'm.text', body: 'hello' },
  ...over,
});
const names = (id: string) => ({ '@bob:x': 'Bob', '@me:x': 'Me' })[id] ?? id;

describe('formatTime', () => {
  it('renders local time in the configured zone', () => {
    expect(formatTime(Date.UTC(2026, 10, 1, 6, 5), 'Europe/Paris')).toBe('2026-11-01 07:05');
  });
});

describe('messageFromEvent', () => {
  it('maps a text message', () => {
    expect(messageFromEvent(ev({}), { names, me: '@me:x' })).toEqual({
      id: '$e1',
      sender: '@bob:x',
      senderName: 'Bob',
      ts: Date.UTC(2026, 10, 1, 6, 5),
      kind: 'text',
      body: 'hello',
    });
  });

  it('flags replies, threads and mentions of me, and drops the reply fallback', () => {
    const m = messageFromEvent(
      ev({
        content: {
          msgtype: 'm.text',
          body: '> <@me:x> question?\n\nanswer',
          'm.relates_to': { 'm.in_reply_to': { event_id: '$q' }, rel_type: 'm.thread', event_id: '$root' },
          'm.mentions': { user_ids: ['@me:x'] },
        },
      }),
      { names, me: '@me:x' },
    );
    expect(m).toMatchObject({ body: 'answer', replyTo: '$q', threadRoot: '$root', mentionsMe: true });
  });

  it('detects a mention by display name when m.mentions is absent', () => {
    expect(messageFromEvent(ev({ content: { msgtype: 'm.text', body: 'thanks Michel-Marie !' } }), { names, me: '@me:x', myNames: ['Michel-Marie'] }).mentionsMe).toBe(true);
    expect(messageFromEvent(ev({ content: { msgtype: 'm.text', body: 'thanks all' } }), { names, me: '@me:x', myNames: ['Michel-Marie'] }).mentionsMe).toBeUndefined();
  });

  it('describes attachments', () => {
    const m = messageFromEvent(
      ev({ content: { msgtype: 'm.file', body: 'report.pdf', info: { mimetype: 'application/pdf', size: 1234 }, file: { url: 'mxc://x/abc' } } }),
      { names, me: '@me:x' },
    );
    expect(m).toMatchObject({ kind: 'file', body: 'report.pdf', attachment: { name: 'report.pdf', mimetype: 'application/pdf', size: 1234, url: 'mxc://x/abc', encrypted: true } });
  });

  it('marks redacted and undecryptable events', () => {
    expect(messageFromEvent(ev({ content: {}, unsigned: { redacted_because: {} } }), { names, me: '@me:x' })).toMatchObject({ kind: 'deleted' });
    expect(messageFromEvent(ev({ type: 'm.room.encrypted', content: { algorithm: 'm.megolm.v1.aes-sha2' } }), { names, me: '@me:x', undecryptable: 'HISTORICAL_MESSAGE_NO_KEY_BACKUP' })).toMatchObject({
      kind: 'undecryptable',
      body: '[encrypted message: no key on this device (HISTORICAL_MESSAGE_NO_KEY_BACKUP)]',
    });
  });

  it('summarises polls and unknown types', () => {
    expect(messageFromEvent(ev({ type: 'org.matrix.msc3381.poll.start', content: { 'org.matrix.msc3381.poll.start': { question: { body: 'Lunch?' } } } }), { names, me: '@me:x' })).toMatchObject({ kind: 'poll', body: 'Lunch?' });
    expect(messageFromEvent(ev({ type: 'm.sticker', content: { body: 'cat' } }), { names, me: '@me:x' })).toMatchObject({ kind: 'other', body: 'cat' });
  });
});

describe('stripReplyFallback', () => {
  it('keeps bodies without a fallback', () => {
    expect(stripReplyFallback('> quote in text')).toBe('> quote in text');
    expect(stripReplyFallback('> <@a:x> q\n> more\n\nreal', true)).toBe('real');
  });
});

describe('applyEdits', () => {
  it('replaces the original body with the latest edit and drops edit events', () => {
    const o = messageFromEvent(ev({ event_id: '$o' }), { names, me: '@me:x' });
    const e1 = messageFromEvent(ev({ event_id: '$e1', origin_server_ts: 2, content: { body: '* v1', 'm.new_content': { msgtype: 'm.text', body: 'v1' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$o' } } }), { names, me: '@me:x' });
    const e2 = messageFromEvent(ev({ event_id: '$e2', origin_server_ts: 3, content: { body: '* v2', 'm.new_content': { msgtype: 'm.text', body: 'v2' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$o' } } }), { names, me: '@me:x' });
    expect(applyEdits([o, e2, e1])).toEqual([{ ...o, body: 'v2', edited: true }]);
  });
});

describe('matchRooms', () => {
  const rooms: RoomView[] = [
    { id: '!a:x', name: 'Équipe Twake', kind: 'group', encrypted: true, members: 5, unread: false, notifications: 0, highlights: 0, lastActivity: 1 },
    { id: '!b:x', name: 'Alice MARTIN', kind: 'dm', dmUserId: '@amartin:x', encrypted: true, members: 2, unread: false, notifications: 0, highlights: 0, lastActivity: 2 },
    { id: '!c:x', name: 'Twake Chat support', alias: '#support:x', kind: 'group', encrypted: false, members: 9, unread: false, notifications: 0, highlights: 0, lastActivity: 3 },
  ];
  it('matches ids, aliases and DM user ids exactly', () => {
    expect(matchRooms(rooms, '!b:x').map((r) => r.id)).toEqual(['!b:x']);
    expect(matchRooms(rooms, '#support:x').map((r) => r.id)).toEqual(['!c:x']);
    expect(matchRooms(rooms, '@amartin:x').map((r) => r.id)).toEqual(['!b:x']);
  });
  it('prefers an exact name, else every word, ignoring case and accents', () => {
    expect(matchRooms(rooms, 'equipe twake').map((r) => r.id)).toEqual(['!a:x']);
    expect(matchRooms(rooms, 'twake').map((r) => r.id)).toEqual(['!c:x', '!a:x']);
    expect(matchRooms(rooms, 'martin').map((r) => r.id)).toEqual(['!b:x']);
    expect(matchRooms(rooms, 'nothing')).toEqual([]);
  });
  it('folds accents', () => {
    expect(fold('Équipe  ÉTÉ')).toBe('equipe ete');
  });
});
