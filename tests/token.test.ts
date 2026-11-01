import { describe, expect, it } from 'vitest';
import { CommandTokenProvider, StaticTokenProvider } from '../src/token.js';

const json = (o: unknown) => `printf '%s' '${JSON.stringify(o)}'`;

describe('CommandTokenProvider', () => {
  it('reads the token, device and user from the JSON output', async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const p = new CommandTokenProvider(json({ access_token: 'tok', expires_at: exp, device_id: 'DEV', user_id: '@a:x' }));
    expect(await p.getSession()).toEqual({ accessToken: 'tok', deviceId: 'DEV', userId: '@a:x', expiresAt: exp * 1000 });
    expect(await p.getToken()).toBe('tok');
  });

  it('caches until shortly before expiry, then runs the command again', async () => {
    const counter = `${process.env.TMPDIR ?? '/tmp'}/mcp-chat-token-${process.pid}-${Math.random()}`;
    const exp = Math.floor(Date.now() / 1000) + 30; // inside the 60 s margin: always renewed
    const cmd = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; printf '{"access_token":"t%s","expires_at":${exp},"device_id":"D"}' $n`;
    const p = new CommandTokenProvider(cmd);
    expect(await p.getToken()).toBe('t1');
    expect(await p.getToken()).toBe('t2');
    const far = new CommandTokenProvider(json({ access_token: 'x', expires_at: exp + 3600, device_id: 'D' }));
    await far.getToken();
    await far.getToken();
  });

  it('shares one run between concurrent callers', async () => {
    const p = new CommandTokenProvider(`sleep 0.2; ${json({ access_token: 'once', expires_at: Math.floor(Date.now() / 1000) + 3600, device_id: 'D' })}`);
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(tokens).toEqual(['once', 'once', 'once']);
  });

  it('refuses output without device id: Matrix crypto needs a stable device', async () => {
    await expect(new CommandTokenProvider(json({ access_token: 't' })).getSession()).rejects.toThrow(/device_id/);
    await expect(new CommandTokenProvider(`printf rawtoken`).getSession()).rejects.toThrow(/device_id/);
  });

  it('reports command failures with the last stderr line', async () => {
    await expect(new CommandTokenProvider(`echo 'no grant: run chat-authorize' >&2; exit 78`).getToken()).rejects.toThrow(
      /token command failed: no grant: run chat-authorize/
    );
    await expect(new CommandTokenProvider(`printf '{bad'`).getToken()).rejects.toThrow(/invalid JSON/);
  });
});

describe('StaticTokenProvider', () => {
  it('returns the configured token and device', async () => {
    const p = new StaticTokenProvider('tok', 'DEV');
    expect(await p.getSession()).toMatchObject({ accessToken: 'tok', deviceId: 'DEV' });
  });
});
