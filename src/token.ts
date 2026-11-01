import { execFile } from 'node:child_process';

export interface Session {
  accessToken: string;
  deviceId: string;
  userId?: string;
  /** epoch milliseconds */
  expiresAt?: number;
}

export interface TokenSource {
  getSession(): Promise<Session>;
  getToken(): Promise<string>;
  /** Forget the cached token (e.g. after a 401). */
  invalidate(): void;
}

export class StaticTokenProvider implements TokenSource {
  constructor(
    private readonly accessToken: string,
    private readonly deviceId: string,
  ) {}
  async getSession(): Promise<Session> {
    return { accessToken: this.accessToken, deviceId: this.deviceId };
  }
  async getToken(): Promise<string> {
    return this.accessToken;
  }
  invalidate(): void {}
}

/**
 * Token provider backed by an external broker command (MATRIX_TOKEN_COMMAND).
 *
 * The command prints JSON `{"access_token", "expires_at" (epoch s), "device_id", "user_id"}`.
 * The broker owns the login (SSO + refresh-token rotation under a lock); the server only
 * consumes short-lived access tokens. The device id is mandatory: the end-to-end
 * encryption store is bound to one device.
 */
export class CommandTokenProvider implements TokenSource {
  private cached: Session | null = null;
  private pending: Promise<Session> | null = null;

  constructor(
    private readonly command: string,
    private readonly options: { marginSeconds?: number; defaultTtlSeconds?: number; timeoutMs?: number } = {},
  ) {}

  async getSession(): Promise<Session> {
    const margin = (this.options.marginSeconds ?? 60) * 1000;
    if (this.cached?.expiresAt && Date.now() + margin < this.cached.expiresAt) return this.cached;
    this.pending ??= this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async getToken(): Promise<string> {
    return (await this.getSession()).accessToken;
  }

  invalidate(): void {
    this.cached = null;
  }

  private run(): Promise<Session> {
    return new Promise((resolve, reject) => {
      execFile(
        '/bin/sh',
        ['-c', this.command],
        { timeout: this.options.timeoutMs ?? 30000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || '').trim().split('\n').slice(-1)[0] || error.message;
            return reject(new Error(`token command failed: ${detail}`));
          }
          const out = String(stdout).trim();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(out) as Record<string, unknown>;
          } catch {
            return reject(
              new Error(out.startsWith('{') ? 'token command printed invalid JSON' : 'token command must print JSON with access_token and device_id'),
            );
          }
          if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
            return reject(new Error('token command JSON has no access_token'));
          }
          if (typeof parsed.device_id !== 'string' || !parsed.device_id) {
            return reject(new Error('token command JSON has no device_id (the encrypted store is bound to one device)'));
          }
          const session: Session = {
            accessToken: parsed.access_token,
            deviceId: parsed.device_id,
            expiresAt:
              typeof parsed.expires_at === 'number'
                ? parsed.expires_at * 1000
                : Date.now() + (this.options.defaultTtlSeconds ?? 60) * 1000,
          };
          if (typeof parsed.user_id === 'string') session.userId = parsed.user_id;
          this.cached = session;
          resolve(session);
        },
      );
    });
  }
}
