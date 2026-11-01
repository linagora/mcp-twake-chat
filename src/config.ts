import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AuthConfig =
  | { method: 'command'; command: string }
  | { method: 'token'; accessToken: string; deviceId: string };

export type RecoveryConfig = { mode: 'tom' } | { mode: 'key'; keyFile: string } | { mode: 'off' };

export type TransportConfig = { kind: 'stdio' } | { kind: 'http'; host: string; port: number; tokenFile?: string };

export interface Config {
  /** Matrix user id, e.g. @alice:example.com */
  userId: string;
  /** Client-Server API base URL; discovered from .well-known when absent */
  homeserverUrl?: string;
  /** ToM server (Twake identity server: directory, profiles, recovery vault); discovered when absent */
  tomUrl?: string;
  auth: AuthConfig;
  recovery: RecoveryConfig;
  /** Private directory holding the encrypted crypto store (0700) */
  storeDir: string;
  /** 32-byte key (base64) encrypting the crypto store; created on first start */
  storeKeyFile: string;
  /** Name of the private room where drafts are posted */
  draftsRoomName: string;
  /** Default directory for download_attachment */
  downloadDir: string;
  /** Where write tools may act: everywhere, or direct messages only */
  sendScope: 'all' | 'dm';
  /** Local full-text index of readable messages (encrypted rooms included) */
  search: { enabled: boolean; file: string; backfillDays: number };
  transport: TransportConfig;
  timeZone: string;
  timeoutMs: number;
}

const USER_ID = /^@[^:\s]+:[^\s]+$/;

export function serverNameOf(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

/** `KEY=VALUE` lines; `#` comments and blank lines ignored; the value may contain `=`. */
export function parseCredentialsFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function httpsUrl(name: string, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error(`${name} must use HTTPS (only localhost may use HTTP)`);
  }
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  let env = input;
  if (env.MATRIX_CREDENTIALS_FILE) {
    env = { ...parseCredentialsFile(readFileSync(env.MATRIX_CREDENTIALS_FILE, 'utf8')), ...env };
  }
  const home = env.HOME ?? '/';
  const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);

  const userId = env.MATRIX_USER_ID ?? '';
  if (!USER_ID.test(userId)) throw new Error('MATRIX_USER_ID is required, e.g. @alice:example.com');

  let auth: AuthConfig;
  if (env.MATRIX_TOKEN_COMMAND) {
    auth = { method: 'command', command: env.MATRIX_TOKEN_COMMAND };
  } else if (env.MATRIX_ACCESS_TOKEN) {
    if (!env.MATRIX_DEVICE_ID) throw new Error('MATRIX_DEVICE_ID is required with MATRIX_ACCESS_TOKEN (the device owning the token)');
    auth = { method: 'token', accessToken: env.MATRIX_ACCESS_TOKEN, deviceId: env.MATRIX_DEVICE_ID };
  } else {
    throw new Error('Set MATRIX_TOKEN_COMMAND (recommended) or MATRIX_ACCESS_TOKEN + MATRIX_DEVICE_ID');
  }

  const mode = env.MATRIX_E2EE_RECOVERY ?? 'tom';
  let recovery: RecoveryConfig;
  if (mode === 'tom' || mode === 'off') recovery = { mode };
  else if (mode === 'key') {
    if (!env.MATRIX_RECOVERY_KEY_FILE) throw new Error('MATRIX_RECOVERY_KEY_FILE is required with MATRIX_E2EE_RECOVERY=key');
    recovery = { mode, keyFile: expand(env.MATRIX_RECOVERY_KEY_FILE) };
  } else throw new Error('MATRIX_E2EE_RECOVERY must be tom, key or off');

  let transport: TransportConfig = { kind: 'stdio' };
  if ((env.MCP_TRANSPORT ?? 'stdio') === 'http') {
    const port = Number(env.MCP_HTTP_PORT ?? 3995);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('MCP_HTTP_PORT must be a TCP port');
    transport = { kind: 'http', host: env.MCP_HTTP_HOST ?? '127.0.0.1', port };
    if (env.MCP_HTTP_TOKEN_FILE) transport.tokenFile = expand(env.MCP_HTTP_TOKEN_FILE);
  }

  const storeDir = expand(env.MATRIX_STORE_DIR ?? join(env.XDG_DATA_HOME ?? join(home, '.local/share'), 'mcp-twake-chat'));
  return {
    userId,
    homeserverUrl: httpsUrl('MATRIX_HOMESERVER_URL', env.MATRIX_HOMESERVER_URL),
    tomUrl: httpsUrl('TOM_URL', env.TOM_URL),
    auth,
    recovery,
    storeDir,
    storeKeyFile: expand(env.MATRIX_STORE_KEY_FILE ?? join(storeDir, 'store.key')),
    draftsRoomName: env.MATRIX_DRAFTS_ROOM_NAME ?? 'Drafts',
    downloadDir: expand(env.MATRIX_DOWNLOAD_DIR ?? '~/Downloads/twake-chat'),
    search: searchConfig(env, storeDir),
    sendScope: sendScopeOf(env.MATRIX_SEND_SCOPE),
    transport,
    timeZone: env.USER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeoutMs: Number(env.MATRIX_TIMEOUT_MS ?? 30000),
  };
}

function searchConfig(env: NodeJS.ProcessEnv, storeDir: string): Config['search'] {
  const flag = (env.MATRIX_SEARCH_INDEX ?? 'on').toLowerCase();
  if (!['on', 'off', 'true', 'false'].includes(flag)) throw new Error('MATRIX_SEARCH_INDEX must be on or off');
  const days = Number(env.MATRIX_SEARCH_BACKFILL_DAYS ?? 365);
  if (!Number.isInteger(days) || days < 0) throw new Error('MATRIX_SEARCH_BACKFILL_DAYS must be a number of days (0 = only new messages)');
  return { enabled: flag === 'on' || flag === 'true', file: join(storeDir, 'search.db'), backfillDays: days };
}

function sendScopeOf(v: string | undefined): Config['sendScope'] {
  const scope = (v ?? 'all').toLowerCase();
  if (scope !== 'all' && scope !== 'dm') throw new Error('MATRIX_SEND_SCOPE must be all or dm');
  return scope;
}
