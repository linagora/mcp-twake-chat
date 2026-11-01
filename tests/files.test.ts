import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guessMime, parseMxc, safeName, uniquePath } from '../src/files.js';

describe('files helpers', () => {
  it('parses mxc URIs', () => {
    expect(parseMxc('mxc://matrix.example.com/AbC123')).toEqual({ server: 'matrix.example.com', mediaId: 'AbC123' });
    expect(() => parseMxc('https://x/y')).toThrow(/mxc/);
  });

  it('guesses MIME types from extensions', () => {
    expect(guessMime('Report.PDF')).toBe('application/pdf');
    expect(guessMime('photo.jpeg')).toBe('image/jpeg');
    expect(guessMime('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(guessMime('noext')).toBe('application/octet-stream');
  });

  it('makes names safe for the local disk', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('a/b\\c:d.txt')).toBe('c_d.txt');
    expect(safeName('')).toBe('attachment');
    expect(safeName('.hidden')).toBe('hidden');
  });

  it('never overwrites an existing file', () => {
    const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'chat-files-'));
    expect(uniquePath(d, 'a.pdf')).toBe(join(d, 'a.pdf'));
    writeFileSync(join(d, 'a.pdf'), 'x');
    expect(uniquePath(d, 'a.pdf')).toBe(join(d, 'a (1).pdf'));
    writeFileSync(join(d, 'a (1).pdf'), 'x');
    expect(uniquePath(d, 'a.pdf')).toBe(join(d, 'a (2).pdf'));
  });
});
