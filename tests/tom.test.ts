import { describe, expect, it, vi } from 'vitest';
import { discover } from '../src/discovery.js';
import { TomClient } from '../src/tom.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const impl = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? 'GET', url, init });
    return handler(url, init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokens = () => {
  let n = 0;
  return { getToken: vi.fn(async () => `tok${++n}`), getSession: vi.fn(), invalidate: vi.fn() };
};

describe('discover', () => {
  it('reads homeserver and ToM from .well-known/matrix/client', async () => {
    const f = fakeFetch(() =>
      json(200, {
        'm.homeserver': { base_url: 'https://matrix.example.com/' },
        'm.identity_server': { base_url: 'https://id.example.com/' },
        't.server': { base_url: 'https://tom.example.com/', server_name: 'example.com' },
      }),
    );
    expect(await discover('@a:example.com', {}, f.impl)).toEqual({ homeserverUrl: 'https://matrix.example.com', tomUrl: 'https://tom.example.com' });
    expect(f.calls[0].url.href).toBe('https://example.com/.well-known/matrix/client');
  });

  it('keeps explicit URLs and skips the lookup when both are given', async () => {
    const f = fakeFetch(() => json(500, {}));
    expect(await discover('@a:example.com', { homeserverUrl: 'https://hs', tomUrl: 'https://tom' }, f.impl)).toEqual({ homeserverUrl: 'https://hs', tomUrl: 'https://tom' });
    expect(f.calls).toHaveLength(0);
  });

  it('falls back to the identity server, then to no ToM', async () => {
    const f = fakeFetch(() => json(200, { 'm.homeserver': { base_url: 'https://hs.example.com' }, 'm.identity_server': { base_url: 'https://id.example.com' } }));
    expect((await discover('@a:example.com', {}, f.impl)).tomUrl).toBe('https://id.example.com');
    const g = fakeFetch(() => json(200, { 'm.homeserver': { base_url: 'https://hs.example.com' } }));
    expect((await discover('@a:example.com', {}, g.impl)).tomUrl).toBeUndefined();
  });

  it('explains how to fix a failed discovery', async () => {
    const f = fakeFetch(() => json(404, {}));
    await expect(discover('@a:example.com', {}, f.impl)).rejects.toThrow(/MATRIX_HOMESERVER_URL/);
  });
});

describe('TomClient', () => {
  it('searches the directory and maps active and inactive matches', async () => {
    const f = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/_twake/identity/v1/lookup/match');
      expect(JSON.parse(String(init.body))).toMatchObject({ val: 'durand', limit: 10 });
      return json(200, {
        matches: [{ uid: '@bdurand:example.com', display_name: 'Bob DURAND', first_name: 'Bob', last_name: 'DURAND', emails: ['g@example.com'], phones: [], mail: '' }],
        inactive_matches: [{ uid: '@old:example.com', display_name: 'Old User', emails: [], phones: [] }],
      });
    });
    const t = tokens();
    const tom = new TomClient('https://tom.example.com', t, f.impl);
    expect(await tom.searchUsers('durand', 10)).toEqual([
      { userId: '@bdurand:example.com', displayName: 'Bob DURAND', firstName: 'Bob', lastName: 'DURAND', emails: ['g@example.com'], phones: [], active: true },
      { userId: '@old:example.com', displayName: 'Old User', emails: [], phones: [], active: false },
    ]);
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok1');
  });

  it('reads a profile', async () => {
    const f = fakeFetch((url) => {
      expect(decodeURIComponent(url.pathname)).toBe('/_twake/v1/user_info/@g:example.com');
      return json(200, { uid: '@g:example.com', display_name: 'G', first_name: 'Gi', last_name: 'L', workplaceFqdn: 'g.twake.example.com' });
    });
    expect(await new TomClient('https://tom.example.com', tokens(), f.impl).userInfo('@g:example.com')).toEqual({
      userId: '@g:example.com',
      displayName: 'G',
      firstName: 'Gi',
      lastName: 'L',
      emails: [],
      phones: [],
      workplace: 'g.twake.example.com',
    });
  });

  it('returns null for an unknown profile and an empty vault', async () => {
    const f = fakeFetch(() => json(404, { error: 'not found' }));
    const tom = new TomClient('https://tom.example.com', tokens(), f.impl);
    expect(await tom.userInfo('@x:example.com')).toBeNull();
    expect(await tom.recoveryWords()).toBeNull();
  });

  it('reads the recovery words', async () => {
    const f = fakeFetch(() => json(200, { words: 'EsT1 2345' }));
    expect(await new TomClient('https://tom.example.com', tokens(), f.impl).recoveryWords()).toBe('EsT1 2345');
  });

  it('retries once with a fresh token after a 401', async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? json(401, { errcode: 'M_UNKNOWN_TOKEN' }) : json(200, { words: 'w' })));
    const t = tokens();
    expect(await new TomClient('https://tom.example.com', t, f.impl).recoveryWords()).toBe('w');
    expect(t.invalidate).toHaveBeenCalledOnce();
    expect((f.calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer tok2');
  });
});
