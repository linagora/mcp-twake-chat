import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageView } from '../src/format.js';
import { ftsQuery, SearchIndex } from '../src/search-index.js';

const msg = (id: string, body: string, ts: number, extra: Partial<MessageView> = {}): MessageView => ({
  id,
  sender: '@alice:x',
  senderName: 'Alice MARTIN',
  ts,
  kind: 'text',
  body,
  ...extra,
});

let idx: SearchIndex | undefined;
const open = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'search-idx-'));
  idx = SearchIndex.open(join(dir, 'search.db'));
  return { idx, file: join(dir, 'search.db') };
};
afterEach(() => idx?.close());

describe('ftsQuery', () => {
  it('turns words into prefix terms that must all match, ignoring punctuation', () => {
    expect(ftsQuery('Réunion budget')).toBe('"Réunion"* "budget"*');
    expect(ftsQuery('contrat "OR" NEAR(x)')).toBe('"contrat"* "OR"* "NEAR"* "x"*');
    expect(ftsQuery(' ?! ')).toBeNull();
  });
});

describe('SearchIndex', () => {
  it('creates a private file and finds words regardless of accents, case and endings', () => {
    const { idx, file } = open();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    idx.add('!a:x', [msg('$1', 'La réunion budgétaire est déplacée à jeudi', 1000), msg('$2', 'Rien à voir', 2000)]);
    expect(idx.search({ text: 'reunion BUDGET' }).map((h) => h.id)).toEqual(['$1']);
    expect(idx.search({ text: 'deplac' })[0]).toMatchObject({ id: '$1', roomId: '!a:x', sender: '@alice:x', senderName: 'Alice MARTIN', ts: 1000 });
  });

  it('filters by rooms, sender and dates, newest first, with a limit', () => {
    const { idx } = open();
    idx.add('!a:x', [msg('$1', 'contrat signé', 1000), msg('$2', 'contrat à relire', 3000, { sender: '@bob:x', senderName: 'Bob DURAND' })]);
    idx.add('!b:x', [msg('$3', 'contrat cadre', 2000)]);
    expect(idx.search({ text: 'contrat' }).map((h) => h.id)).toEqual(['$2', '$3', '$1']);
    expect(idx.search({ text: 'contrat', roomIds: ['!a:x'] }).map((h) => h.id)).toEqual(['$2', '$1']);
    expect(idx.search({ text: 'contrat', sender: '@bob:x' }).map((h) => h.id)).toEqual(['$2']);
    expect(idx.search({ text: 'contrat', since: 1500, until: 2500 }).map((h) => h.id)).toEqual(['$3']);
    expect(idx.search({ text: 'contrat', limit: 1 }).map((h) => h.id)).toEqual(['$2']);
  });

  it('is idempotent, applies edits to the original and forgets deleted messages', () => {
    const { idx } = open();
    idx.add('!a:x', [msg('$1', 'premier jet', 1000)]);
    idx.add('!a:x', [msg('$1', 'premier jet', 1000)]);
    expect(idx.stats().messages).toBe(1);
    idx.add('!a:x', [msg('$e', '* version finale', 1500, { replaces: '$1' })]);
    expect(idx.search({ text: 'jet' })).toEqual([]);
    expect(idx.search({ text: 'finale' })[0]).toMatchObject({ id: '$1', ts: 1000 });
    idx.add('!a:x', [msg('$1', '', 1000, { kind: 'deleted', body: undefined })]);
    expect(idx.search({ text: 'finale' })).toEqual([]);
    idx.add('!a:x', [msg('$2', 'secret', 2000)]);
    idx.remove('$2');
    expect(idx.search({ text: 'secret' })).toEqual([]);
  });

  it('indexes file names and skips undecryptable messages', () => {
    const { idx } = open();
    idx.add('!a:x', [
      msg('$f', 'rapport-annuel.pdf', 1000, { kind: 'file' }),
      msg('$u', '[encrypted message: no key on this device (X)]', 1000, { kind: 'undecryptable' }),
    ]);
    expect(idx.search({ text: 'rapport annuel' }).map((h) => h.id)).toEqual(['$f']);
    expect(idx.search({ text: 'encrypted' })).toEqual([]);
  });

  it('remembers the newest indexed message of each room (catch-up after a restart)', () => {
    const { idx } = open();
    expect(idx.newestTs('!a:x')).toBeUndefined();
    idx.add('!a:x', [msg('$1', 'un', 3000), msg('$2', 'deux', 1000)]);
    idx.add('!a:x', [msg('$3', 'trois', 2000)]);
    expect(idx.newestTs('!a:x')).toBe(3000);
    idx.setProgress('!a:x', { token: 't', complete: false, oldestTs: 1000 });
    expect(idx.newestTs('!a:x')).toBe(3000);
  });

  it('keeps the backfill progress of each room', () => {
    const { idx } = open();
    expect(idx.progress('!a:x')).toEqual({ token: null, complete: false, oldestTs: undefined });
    idx.setProgress('!a:x', { token: 't42', complete: false, oldestTs: 500 });
    idx.setProgress('!b:x', { token: null, complete: true, oldestTs: 100 });
    expect(idx.progress('!a:x')).toEqual({ token: 't42', complete: false, oldestTs: 500 });
    expect(idx.stats()).toEqual({ messages: 0, rooms: 2, completeRooms: 1 });
  });
});
