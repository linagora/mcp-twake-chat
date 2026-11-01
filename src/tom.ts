/**
 * ToM server (Twake identity server, linagora/ToM-Server): company directory,
 * user profiles and the vault where Twake Chat keeps the user's recovery key.
 * Every route accepts the Matrix access token (validated through /account/whoami).
 */

export interface DirectoryUser {
  userId: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  emails: string[];
  phones: string[];
  workplace?: string;
  /** false = known to the directory but never logged in to the chat */
  active?: boolean;
}

interface TokenLike {
  getToken(): Promise<string>;
  invalidate(): void;
}

type Raw = Record<string, unknown>;

const strings = (...values: unknown[]): string[] => {
  const out: string[] = [];
  for (const v of values) {
    for (const s of Array.isArray(v) ? v : [v]) if (typeof s === 'string' && s && !out.includes(s)) out.push(s);
  }
  return out;
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function toUser(raw: Raw, active?: boolean): DirectoryUser {
  const userId = String(raw.uid ?? raw.address ?? '');
  const user: DirectoryUser = {
    userId,
    displayName: str(raw.display_name) ?? str(raw.displayName) ?? str(raw.cn) ?? userId,
    emails: strings(raw.emails, raw.mail),
    phones: strings(raw.phones, raw.mobile),
  };
  const firstName = str(raw.first_name) ?? str(raw.givenName);
  const lastName = str(raw.last_name) ?? str(raw.sn);
  if (firstName) user.firstName = firstName;
  if (lastName) user.lastName = lastName;
  const workplace = str(raw.workplaceFqdn);
  if (workplace) user.workplace = workplace;
  if (active !== undefined) user.active = active;
  return user;
}

export class TomClient {
  constructor(
    readonly baseUrl: string,
    private readonly tokens: TokenLike,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20000,
  ) {}

  private async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${await this.tokens.getToken()}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      return res;
    }
  }

  private static async fail(res: Response, what: string): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as Raw;
    throw new Error(`ToM ${what}: HTTP ${res.status} ${String(body.error ?? body.message ?? '')}`.trim());
  }

  /** Company directory search (name, first name, e-mail…). */
  async searchUsers(query: string, limit = 10): Promise<DirectoryUser[]> {
    const res = await this.request('/_twake/identity/v1/lookup/match', {
      method: 'POST',
      body: {
        scope: ['uid', 'cn', 'displayName', 'givenName', 'sn', 'mail'],
        fields: ['uid', 'cn', 'displayName', 'givenName', 'sn', 'mail', 'mobile'],
        val: query,
        limit,
      },
    });
    if (!res.ok) return TomClient.fail(res, 'directory search');
    const body = (await res.json()) as { matches?: Raw[]; inactive_matches?: Raw[] };
    return [...(body.matches ?? []).map((m) => toUser(m, true)), ...(body.inactive_matches ?? []).map((m) => toUser(m, false))];
  }

  async userInfo(userId: string): Promise<DirectoryUser | null> {
    const res = await this.request(`/_twake/v1/user_info/${encodeURIComponent(userId)}`);
    if (res.status === 404) return null;
    if (!res.ok) return TomClient.fail(res, 'user info');
    return toUser((await res.json()) as Raw);
  }

  /** Recovery key Twake Chat stored for this user, or null. Never log it. */
  async recoveryWords(): Promise<string | null> {
    const res = await this.request('/_twake/recoveryWords');
    if (res.status === 404) return null;
    if (!res.ok) return TomClient.fail(res, 'recovery vault');
    const words = ((await res.json()) as Raw).words;
    return typeof words === 'string' && words ? words : null;
  }
}
