import { describe, expect, it } from 'vitest';
import { editContent, fileContent, textContent } from '../src/content.js';

describe('textContent', () => {
  it('keeps plain text plain', () => {
    expect(textContent('hello')).toEqual({ msgtype: 'm.text', body: 'hello' });
  });

  it('adds HTML when the text uses Markdown', () => {
    const c = textContent('**Point 1** and a [link](https://example.com)\n\n- a\n- b');
    expect(c.format).toBe('org.matrix.custom.html');
    expect(c.formatted_body).toContain('<strong>Point 1</strong>');
    expect(c.formatted_body).toContain('<a href="https://example.com">link</a>');
    expect(c.formatted_body).toContain('<li>a</li>');
    expect(c.body).toBe('**Point 1** and a [link](https://example.com)\n\n- a\n- b');
  });

  it('escapes raw HTML instead of rendering it', () => {
    const inline = textContent('**x** <script>alert(1)</script>');
    expect(inline.formatted_body).toContain('<strong>x</strong>');
    expect(inline.formatted_body).not.toContain('<script>');
    expect(inline.formatted_body).toContain('&lt;script&gt;');
    // an HTML block alone stays plain text (no formatted_body at all)
    expect(textContent('<script>alert(1)</script>').formatted_body ?? '').not.toContain('<script>');
  });

  it('builds replies and thread replies', () => {
    expect(textContent('ok', { replyTo: '$q' })['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$q' } });
    expect(textContent('ok', { threadRoot: '$root' })['m.relates_to']).toEqual({ rel_type: 'm.thread', event_id: '$root', is_falling_back: true, 'm.in_reply_to': { event_id: '$root' } });
    expect(textContent('ok', { threadRoot: '$root', replyTo: '$m' })['m.relates_to']).toEqual({ rel_type: 'm.thread', event_id: '$root', is_falling_back: false, 'm.in_reply_to': { event_id: '$m' } });
  });

  it('declares mentions', () => {
    expect(textContent('hi', { mentions: ['@a:x'] })['m.mentions']).toEqual({ user_ids: ['@a:x'] });
  });
});

describe('editContent', () => {
  it('builds an m.replace edit with a fallback body', () => {
    expect(editContent('$orig', 'fixed')).toEqual({
      msgtype: 'm.text',
      body: '* fixed',
      'm.new_content': { msgtype: 'm.text', body: 'fixed' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
    });
  });
});

describe('fileContent', () => {
  it('picks the msgtype from the MIME type and describes the file', () => {
    expect(fileContent({ name: 'a.png', mimetype: 'image/png', size: 10, url: 'mxc://x/a' })).toEqual({ msgtype: 'm.image', body: 'a.png', filename: 'a.png', info: { mimetype: 'image/png', size: 10 }, url: 'mxc://x/a' });
    expect(fileContent({ name: 'r.pdf', mimetype: 'application/pdf', size: 5, file: { url: 'mxc://x/r' } as never }).msgtype).toBe('m.file');
    expect(fileContent({ name: 'r.pdf', mimetype: 'application/pdf', size: 5, file: { url: 'mxc://x/r' } as never })).not.toHaveProperty('url');
    expect(fileContent({ name: 's.ogg', mimetype: 'audio/ogg', size: 1, url: 'mxc://x/s' }).msgtype).toBe('m.audio');
    expect(fileContent({ name: 'v.mp4', mimetype: 'video/mp4', size: 1, url: 'mxc://x/v', caption: 'the demo' })).toMatchObject({ msgtype: 'm.video', body: 'the demo', filename: 'v.mp4' });
  });
});
