import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Refuses a local path outside `root`, following symbolic links through the deepest existing
 * ancestor (the target itself may not exist yet). Prevents reading secrets or writing anywhere
 * on the machine on behalf of a message or document that asks the assistant to.
 */
export function assertInside(root: string, target: string, variable: string): void {
  if (!isAbsolute(target)) throw new Error(`the path must be absolute: ${target}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let existing = resolve(target);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const rel = relative(realpathSync(root), realpathSync(existing));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`the local path must stay inside ${root} (${variable})`);
  }
}

export function parseMxc(uri: string): { server: string; mediaId: string } {
  const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(uri);
  if (!m) throw new Error(`not an mxc:// URI: ${uri}`);
  return { server: m[1], mediaId: m[2] };
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

export function guessMime(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Last path segment, without separators, drive colons or a leading dot. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[:\0]/g, '_').replace(/^\.+/, '').trim();
  return clean || 'attachment';
}

/** `dir/name`, or `dir/name (n).ext` when the file already exists. */
export function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let n = 1; existsSync(p); n++) p = join(dir, `${stem} (${n})${ext}`);
  return p;
}
