/** Matrix event contents for text, edits and files (Markdown rendered to the Matrix HTML subset). */
import { Marked } from 'marked';
import type { EncryptedFile } from './attachment.js';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Raw HTML typed in the text is shown as text, never rendered.
const md = new Marked({ gfm: true, breaks: true, renderer: { html: ({ text }) => escapeHtml(text) } });

export interface TextOptions {
  replyTo?: string;
  threadRoot?: string;
  mentions?: string[];
}

export type Content = Record<string, unknown> & { msgtype: string; body: string; format?: string; formatted_body?: string };

function render(text: string): Pick<Content, 'format' | 'formatted_body'> {
  const html = (md.parse(text, { async: false }) as string).trim();
  const onlyParagraphs = html.replace(/<\/?p>|<br>/g, '');
  if (!/[<]/.test(onlyParagraphs) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(onlyParagraphs)) return {};
  return { format: 'org.matrix.custom.html', formatted_body: html };
}

export function textContent(text: string, opts: TextOptions = {}): Content {
  const c: Content = { msgtype: 'm.text', body: text, ...render(text) };
  if (opts.threadRoot) {
    c['m.relates_to'] = { rel_type: 'm.thread', event_id: opts.threadRoot, is_falling_back: !opts.replyTo, 'm.in_reply_to': { event_id: opts.replyTo ?? opts.threadRoot } };
  } else if (opts.replyTo) {
    c['m.relates_to'] = { 'm.in_reply_to': { event_id: opts.replyTo } };
  }
  if (opts.mentions?.length) c['m.mentions'] = { user_ids: opts.mentions };
  return c;
}

export function editContent(originalId: string, text: string): Content {
  const next = textContent(text);
  const c: Content = { msgtype: 'm.text', body: `* ${text}`, 'm.new_content': next, 'm.relates_to': { rel_type: 'm.replace', event_id: originalId } };
  if (next.formatted_body) {
    c.format = 'org.matrix.custom.html';
    c.formatted_body = `* ${next.formatted_body}`;
  }
  return c;
}

export function fileContent(f: { name: string; mimetype: string; size: number; url?: string; file?: EncryptedFile; caption?: string }): Content {
  const top = f.mimetype.split('/')[0];
  const msgtype = top === 'image' ? 'm.image' : top === 'audio' ? 'm.audio' : top === 'video' ? 'm.video' : 'm.file';
  const c: Content = { msgtype, body: f.caption ?? f.name, filename: f.name, info: { mimetype: f.mimetype, size: f.size } };
  if (f.file) c.file = f.file;
  else c.url = f.url;
  return c;
}
