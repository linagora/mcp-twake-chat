import { serverNameOf } from './config.js';

export interface Endpoints {
  homeserverUrl: string;
  tomUrl?: string;
}

const trim = (u: unknown) => (typeof u === 'string' && u ? u.replace(/\/+$/, '') : undefined);

/**
 * Resolve the Client-Server API and the ToM server from the user's domain
 * (`https://<server>/.well-known/matrix/client`), unless both are configured.
 */
export async function discover(
  userId: string,
  explicit: { homeserverUrl?: string; tomUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Endpoints> {
  if (explicit.homeserverUrl && explicit.tomUrl) return { homeserverUrl: explicit.homeserverUrl, tomUrl: explicit.tomUrl };
  const url = `https://${serverNameOf(userId)}/.well-known/matrix/client`;
  let wk: Record<string, { base_url?: unknown } | undefined>;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    wk = (await res.json()) as typeof wk;
  } catch (e) {
    if (explicit.homeserverUrl) return { homeserverUrl: explicit.homeserverUrl };
    throw new Error(`cannot discover the homeserver from ${url} (${(e as Error).message}): set MATRIX_HOMESERVER_URL`);
  }
  const homeserverUrl = explicit.homeserverUrl ?? trim(wk['m.homeserver']?.base_url);
  if (!homeserverUrl) throw new Error(`${url} has no m.homeserver: set MATRIX_HOMESERVER_URL`);
  const tomUrl = explicit.tomUrl ?? trim(wk['t.server']?.base_url) ?? trim(wk['m.identity_server']?.base_url);
  return tomUrl ? { homeserverUrl, tomUrl } : { homeserverUrl };
}
