/**
 * Local full-text index of the messages this device can read (SQLite FTS5, built into Node).
 *
 * Synapse cannot search end-to-end encrypted rooms (it never sees the text), so the
 * server keeps its own index of decrypted messages, like Element's Seshat. The file
 * holds message text in clear: it lives next to the crypto store, with 0600 permissions.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MessageView } from './format.js';

export interface SearchHit {
  id: string;
  roomId: string;
  sender: string;
  senderName: string;
  ts: number;
  body: string;
  threadRoot?: string;
}

export interface SearchQuery {
  text: string;
  roomIds?: string[];
  sender?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface Progress {
  /** pagination token to continue the backfill backwards; null = start from the newest message */
  token: string | null;
  complete: boolean;
  oldestTs?: number;
}

const INDEXED_KINDS = new Set(['text', 'notice', 'emote', 'file', 'image', 'audio', 'video', 'poll']);

/** Words of the query as FTS5 prefix terms, all required. Null when the query has no word. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export class SearchIndex {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): SearchIndex {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600));
    chmodSync(file, 0o600);
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE VIRTUAL TABLE IF NOT EXISTS msg USING fts5(
        body, event_id UNINDEXED, room_id UNINDEXED, sender UNINDEXED, sender_name UNINDEXED,
        ts UNINDEXED, thread_root UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS backfill (
        room_id TEXT PRIMARY KEY, token TEXT, complete INTEGER NOT NULL DEFAULT 0, oldest_ts INTEGER, newest_ts INTEGER
      );
    `);
    return new SearchIndex(db);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Index message views of one room: new messages, edits (applied to the original) and deletions. */
  add(roomId: string, views: MessageView[]): void {
    const del = this.db.prepare('DELETE FROM msg WHERE event_id = ?');
    const ins = this.db.prepare('INSERT INTO msg (body, event_id, room_id, sender, sender_name, ts, thread_root) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const upd = this.db.prepare('UPDATE msg SET body = ? WHERE event_id = ?');
    let newest: number | undefined;
    this.db.exec('BEGIN');
    try {
      for (const m of views) {
        if (m.kind === 'deleted') {
          del.run(m.id);
          continue;
        }
        if (!INDEXED_KINDS.has(m.kind) || !m.body) continue;
        if (m.replaces) {
          upd.run(m.body.replace(/^\* /, ''), m.replaces);
          continue;
        }
        del.run(m.id);
        ins.run(m.body, m.id, roomId, m.sender, m.senderName, m.ts, m.threadRoot ?? null);
        if (newest === undefined || m.ts > newest) newest = m.ts;
      }
      if (newest !== undefined) {
        this.db
          .prepare('INSERT INTO backfill (room_id, newest_ts) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET newest_ts = max(coalesce(newest_ts, 0), excluded.newest_ts)')
          .run(roomId, newest);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  remove(eventId: string): void {
    this.db.prepare('DELETE FROM msg WHERE event_id = ?').run(eventId);
  }

  search(q: SearchQuery): SearchHit[] {
    const match = ftsQuery(q.text);
    if (!match) return [];
    const where = ['msg MATCH ?'];
    const args: (string | number)[] = [match];
    if (q.roomIds?.length) {
      where.push(`room_id IN (${q.roomIds.map(() => '?').join(',')})`);
      args.push(...q.roomIds);
    }
    if (q.sender) {
      where.push('sender = ?');
      args.push(q.sender);
    }
    if (q.since !== undefined) {
      where.push('ts >= ?');
      args.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('ts < ?');
      args.push(q.until);
    }
    args.push(q.limit ?? 50);
    const rows = this.db
      .prepare(`SELECT event_id, room_id, sender, sender_name, ts, body, thread_root FROM msg WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...args) as Record<string, string | number | null>[];
    return rows.map((r) => {
      const hit: SearchHit = {
        id: String(r.event_id),
        roomId: String(r.room_id),
        sender: String(r.sender),
        senderName: String(r.sender_name),
        ts: Number(r.ts),
        body: String(r.body),
      };
      if (r.thread_root) hit.threadRoot = String(r.thread_root);
      return hit;
    });
  }

  /** Timestamp of the newest message indexed in the room. */
  newestTs(roomId: string): number | undefined {
    const r = this.db.prepare('SELECT newest_ts FROM backfill WHERE room_id = ?').get(roomId) as { newest_ts: number | null } | undefined;
    return r?.newest_ts ?? undefined;
  }

  progress(roomId: string): Progress {
    const r = this.db.prepare('SELECT token, complete, oldest_ts FROM backfill WHERE room_id = ?').get(roomId) as
      | { token: string | null; complete: number; oldest_ts: number | null }
      | undefined;
    return { token: r?.token ?? null, complete: Boolean(r?.complete), oldestTs: r?.oldest_ts ?? undefined };
  }

  setProgress(roomId: string, p: Progress): void {
    this.db
      .prepare('INSERT INTO backfill (room_id, token, complete, oldest_ts) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET token = excluded.token, complete = excluded.complete, oldest_ts = excluded.oldest_ts')
      .run(roomId, p.token, p.complete ? 1 : 0, p.oldestTs ?? null);
  }

  stats(): { messages: number; rooms: number; completeRooms: number } {
    const m = this.db.prepare('SELECT count(*) AS n FROM msg').get() as { n: number };
    const b = this.db.prepare('SELECT count(*) AS n, coalesce(sum(complete), 0) AS c FROM backfill').get() as { n: number; c: number };
    return { messages: Number(m.n), rooms: Number(b.n), completeRooms: Number(b.c) };
  }
}
