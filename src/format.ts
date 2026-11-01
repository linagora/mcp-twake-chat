/** Pure helpers turning Matrix events and rooms into compact, assistant-friendly views. */

export interface RawEvent {
  event_id: string;
  room_id?: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export type MessageKind =
  | 'text'
  | 'notice'
  | 'emote'
  | 'image'
  | 'file'
  | 'audio'
  | 'video'
  | 'location'
  | 'poll'
  | 'deleted'
  | 'undecryptable'
  | 'other';

export interface Attachment {
  name: string;
  mimetype?: string;
  size?: number;
  /** mxc:// URI */
  url?: string;
  encrypted?: boolean;
}

export interface MessageView {
  id: string;
  sender: string;
  senderName: string;
  ts: number;
  kind: MessageKind;
  body?: string;
  replyTo?: string;
  threadRoot?: string;
  mentionsMe?: boolean;
  edited?: boolean;
  attachment?: Attachment;
  /** set on edit events only; consumed by applyEdits */
  replaces?: string;
}

export interface RoomView {
  id: string;
  name: string;
  kind: 'dm' | 'group' | 'space';
  alias?: string;
  topic?: string;
  dmUserId?: string;
  encrypted: boolean;
  members: number;
  /** a message from someone else follows the user's read receipt */
  unread: boolean;
  /** server notification count (0 when the user's push rules mute the room) */
  notifications: number;
  highlights: number;
  lastActivity: number;
}

export function formatTime(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Remove the `> <@user> quoted text` block clients prepend to replies. */
export function stripReplyFallback(body: string, isReply = false): string {
  if (!isReply || !body.startsWith('> ')) return body;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

const KINDS: Record<string, MessageKind> = {
  'm.text': 'text',
  'm.notice': 'notice',
  'm.emote': 'emote',
  'm.image': 'image',
  'm.file': 'file',
  'm.audio': 'audio',
  'm.video': 'video',
  'm.location': 'location',
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface ViewContext {
  names: (userId: string) => string;
  me: string;
  /** Display names that count as a mention when m.mentions is absent */
  myNames?: string[];
  /** Decryption failure code when the event could not be decrypted */
  undecryptable?: string;
}

export function messageFromEvent(e: RawEvent, ctx: ViewContext): MessageView {
  const view: MessageView = { id: e.event_id, sender: e.sender, senderName: ctx.names(e.sender), ts: e.origin_server_ts, kind: 'other' };
  const c = e.content ?? {};

  if (ctx.undecryptable || e.type === 'm.room.encrypted') {
    view.kind = 'undecryptable';
    view.body = `[encrypted message: no key on this device (${ctx.undecryptable ?? 'UNKNOWN'})]`;
    return view;
  }
  if (e.unsigned?.redacted_because || Object.keys(c).length === 0) {
    view.kind = 'deleted';
    return view;
  }

  const rel = obj(c['m.relates_to']);
  const newContent = rel?.rel_type === 'm.replace' ? obj(c['m.new_content']) : undefined;
  const content = newContent ?? c;
  if (newContent) view.replaces = str(rel?.event_id);

  const replyTo = str(obj(rel?.['m.in_reply_to'])?.event_id);
  if (replyTo && !newContent) view.replyTo = replyTo;
  if (rel?.rel_type === 'm.thread') view.threadRoot = str(rel.event_id);

  if (e.type === 'm.room.message') {
    view.kind = KINDS[str(content.msgtype) ?? ''] ?? 'other';
    const body = str(content.body);
    if (body !== undefined) view.body = stripReplyFallback(body, Boolean(replyTo));
    if (['image', 'file', 'audio', 'video'].includes(view.kind)) {
      const info = obj(content.info);
      const file = obj(content.file);
      const att: Attachment = { name: str(content.filename) ?? body ?? 'attachment' };
      if (str(info?.mimetype)) att.mimetype = str(info?.mimetype);
      if (typeof info?.size === 'number') att.size = info.size;
      const url = str(content.url) ?? str(file?.url);
      if (url) att.url = url;
      if (file) att.encrypted = true;
      view.attachment = att;
    }
  } else if (e.type.endsWith('poll.start')) {
    view.kind = 'poll';
    const poll = obj(c['org.matrix.msc3381.poll.start']) ?? obj(c['m.poll']);
    view.body = str(obj(poll?.question)?.body) ?? str(c.body);
  } else {
    const body = str(c.body);
    if (body !== undefined) view.body = body;
  }

  const mentions = obj(c['m.mentions']);
  if (mentions) {
    if (Array.isArray(mentions.user_ids) && mentions.user_ids.includes(ctx.me)) view.mentionsMe = true;
  } else if (view.body) {
    const b = fold(view.body);
    if (b.includes(fold(ctx.me)) || (ctx.myNames ?? []).some((n) => n && b.includes(fold(n)))) view.mentionsMe = true;
  }
  return view;
}

/** Apply `m.replace` edits to their originals (latest wins) and drop the edit events. */
export function applyEdits(messages: MessageView[]): MessageView[] {
  const latest = new Map<string, MessageView>();
  for (const m of messages) {
    if (m.replaces && (!latest.has(m.replaces) || latest.get(m.replaces)!.ts < m.ts)) latest.set(m.replaces, m);
  }
  const out: MessageView[] = [];
  const present = new Set(messages.filter((m) => !m.replaces).map((m) => m.id));
  for (const m of messages) {
    if (m.replaces) {
      // edit of a message outside the page: keep the newest edit alone
      if (!present.has(m.replaces) && latest.get(m.replaces) === m) {
        const { replaces, ...rest } = m;
        out.push({ ...rest, id: replaces, edited: true });
      }
      continue;
    }
    const edit = latest.get(m.id);
    if (!edit) {
      out.push(m);
      continue;
    }
    const merged: MessageView = { ...m, edited: true };
    if (edit.body !== undefined) merged.body = edit.body;
    if (edit.attachment) merged.attachment = edit.attachment;
    out.push(merged);
  }
  return out;
}

/** Rooms matching an id, alias, DM user id, exact name, or every word of the query. Most recent first. */
export function matchRooms(rooms: RoomView[], query: string): RoomView[] {
  const q = query.trim();
  const exactId = rooms.filter((r) => r.id === q || r.alias === q || r.dmUserId === q);
  if (exactId.length) return exactId;
  const fq = fold(q);
  if (!fq) return [];
  const byRecent = (a: RoomView, b: RoomView) => b.lastActivity - a.lastActivity;
  const exactName = rooms.filter((r) => fold(r.name) === fq);
  if (exactName.length) return exactName.sort(byRecent);
  const words = fq.split(' ');
  return rooms.filter((r) => words.every((w) => fold(`${r.name} ${r.alias ?? ''} ${r.dmUserId ?? ''}`).includes(w))).sort(byRecent);
}
