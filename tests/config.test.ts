import { describe, expect, it } from 'vitest';
import { loadConfig, parseCredentialsFile, serverNameOf } from '../src/config.js';

const base = { MATRIX_USER_ID: '@alice:example.com', MATRIX_TOKEN_COMMAND: 'broker chat-token --json' };

describe('loadConfig', () => {
  it('needs a valid Matrix user id', () => {
    expect(() => loadConfig({ MATRIX_TOKEN_COMMAND: 'x' })).toThrow(/MATRIX_USER_ID/);
    expect(() => loadConfig({ ...base, MATRIX_USER_ID: 'alice@example.com' })).toThrow(/MATRIX_USER_ID/);
  });

  it('needs a token command or a static token with its device id', () => {
    expect(() => loadConfig({ MATRIX_USER_ID: '@a:example.com' })).toThrow(/MATRIX_TOKEN_COMMAND/);
    expect(() => loadConfig({ MATRIX_USER_ID: '@a:example.com', MATRIX_ACCESS_TOKEN: 't' })).toThrow(/MATRIX_DEVICE_ID/);
    const c = loadConfig({ MATRIX_USER_ID: '@a:example.com', MATRIX_ACCESS_TOKEN: 't', MATRIX_DEVICE_ID: 'DEV' });
    expect(c.auth).toEqual({ method: 'token', accessToken: 't', deviceId: 'DEV' });
  });

  it('defaults to the token command, TOM recovery, stdio and private XDG directories', () => {
    const c = loadConfig({ ...base, HOME: '/home/alice' });
    expect(c.auth).toEqual({ method: 'command', command: 'broker chat-token --json' });
    expect(c.userId).toBe('@alice:example.com');
    expect(c.homeserverUrl).toBeUndefined();
    expect(c.recovery).toEqual({ mode: 'tom' });
    expect(c.storeDir).toBe('/home/alice/.local/share/mcp-twake-chat');
    expect(c.storeKeyFile).toBe('/home/alice/.local/share/mcp-twake-chat/store.key');
    expect(c.transport).toEqual({ kind: 'stdio' });
    expect(c.draftsRoomName).toBe('Drafts');
    expect(c.downloadDir).toBe('/home/alice/Downloads/twake-chat');
    expect(c.sendScope).toBe('all');
    expect(loadConfig({ ...base, HOME: '/h', MATRIX_SEND_SCOPE: 'dm' }).sendScope).toBe('dm');
    expect(() => loadConfig({ ...base, HOME: '/h', MATRIX_SEND_SCOPE: 'rooms' })).toThrow(/MATRIX_SEND_SCOPE/);
    expect(c.search).toEqual({ enabled: true, file: '/home/alice/.local/share/mcp-twake-chat/search.db', backfillDays: 365 });
  });

  it('configures the local search index', () => {
    expect(loadConfig({ ...base, HOME: '/h', MATRIX_SEARCH_INDEX: 'off' }).search.enabled).toBe(false);
    expect(loadConfig({ ...base, HOME: '/h', MATRIX_SEARCH_BACKFILL_DAYS: '30' }).search.backfillDays).toBe(30);
    expect(loadConfig({ ...base, HOME: '/h', MATRIX_SEARCH_BACKFILL_DAYS: '0' }).search.backfillDays).toBe(0);
    expect(() => loadConfig({ ...base, HOME: '/h', MATRIX_SEARCH_BACKFILL_DAYS: 'x' })).toThrow(/MATRIX_SEARCH_BACKFILL_DAYS/);
    expect(() => loadConfig({ ...base, HOME: '/h', MATRIX_SEARCH_INDEX: 'maybe' })).toThrow(/MATRIX_SEARCH_INDEX/);
  });

  it('refuses plain HTTP except on localhost', () => {
    expect(() => loadConfig({ ...base, MATRIX_HOMESERVER_URL: 'http://matrix.example.com' })).toThrow(/HTTPS/);
    expect(loadConfig({ ...base, MATRIX_HOMESERVER_URL: 'http://localhost:8008/' }).homeserverUrl).toBe('http://localhost:8008');
    expect(() => loadConfig({ ...base, TOM_URL: 'http://tom.example.com' })).toThrow(/HTTPS/);
  });

  it('reads the recovery mode', () => {
    expect(loadConfig({ ...base, MATRIX_E2EE_RECOVERY: 'off' }).recovery).toEqual({ mode: 'off' });
    expect(() => loadConfig({ ...base, MATRIX_E2EE_RECOVERY: 'key' })).toThrow(/MATRIX_RECOVERY_KEY_FILE/);
    expect(loadConfig({ ...base, MATRIX_E2EE_RECOVERY: 'key', MATRIX_RECOVERY_KEY_FILE: '/k' }).recovery).toEqual({ mode: 'key', keyFile: '/k' });
    expect(() => loadConfig({ ...base, MATRIX_E2EE_RECOVERY: 'maybe' })).toThrow(/MATRIX_E2EE_RECOVERY/);
  });

  it('configures the local HTTP transport', () => {
    const c = loadConfig({ ...base, MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '4100', MCP_HTTP_TOKEN_FILE: '/t' });
    expect(c.transport).toEqual({ kind: 'http', host: '127.0.0.1', port: 4100, tokenFile: '/t' });
    expect(() => loadConfig({ ...base, MCP_TRANSPORT: 'http', MCP_HTTP_PORT: 'abc' })).toThrow(/MCP_HTTP_PORT/);
  });

  it('expands ~ in paths', () => {
    const c = loadConfig({ ...base, HOME: '/home/alice', MATRIX_STORE_DIR: '~/store', MATRIX_STORE_KEY_FILE: '~/k' });
    expect(c.storeDir).toBe('/home/alice/store');
    expect(c.storeKeyFile).toBe('/home/alice/k');
  });
});

describe('helpers', () => {
  it('extracts the server name of a user id', () => {
    expect(serverNameOf('@alice:example.com')).toBe('example.com');
    expect(serverNameOf('@alice:example.com:8448')).toBe('example.com:8448');
  });

  it('parses a credentials file', () => {
    expect(parseCredentialsFile('# secrets\nMATRIX_ACCESS_TOKEN=abc=def\n\nMATRIX_DEVICE_ID = DEV\n')).toEqual({
      MATRIX_ACCESS_TOKEN: 'abc=def',
      MATRIX_DEVICE_ID: 'DEV',
    });
  });
});
