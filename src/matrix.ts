/**
 * MatrixChat: the real ChatService, on matrix-js-sdk with the Rust crypto (WASM)
 * and a persistent, encrypted IndexedDB store emulated on SQLite (indexeddbshim).
 *
 * Start-up order (validated by spikes 001-002):
 *   lock store -> crypto from store -> initial sync -> if keys missing locally:
 *   recovery key (ToM vault or file) -> SSSS -> cross-signing import + sign this device
 *   -> backup key -> restore backup.  Then a live sync keeps receiving room keys.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decryptAttachment, encryptAttachment } from './attachment.js';
import { editContent, fileContent, textContent } from './content.js';
import { guessMime, parseMxc, safeName, uniquePath } from './files.js';
import type { Config } from './config.js';
import type { Endpoints } from './discovery.js';
import { applyEdits, messageFromEvent, type MessageView, type RawEvent, type RoomView } from './format.js';
import { SearchIndex, type SearchHit } from './search-index.js';
import type { ChatService, EncryptionStatus, Identity, Invitation, Member, MentionHit, MessageQuery, NewRoom, Page, SearchRequest, SearchResult, UnreadRoom } from './service.js';
import { acquireStoreLock, loadOrCreateStoreKey } from './store.js';
import type { TomClient } from './tom.js';
import type { TokenSource } from './token.js';

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

const DRAFTS_ACCOUNT_DATA = 'ai.twake.mcp.drafts_room';
const MESSAGE_TYPES = new Set(['m.room.message', 'm.room.encrypted', 'm.sticker', 'org.matrix.msc3381.poll.start', 'm.poll.start']);
const RETRYABLE = new Set(['MEGOLM_UNKNOWN_INBOUND_SESSION_ID', 'HISTORICAL_MESSAGE_WORKING_BACKUP', 'MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let sdkPromise: Promise<{ sdk: Sdk; decodeRecoveryKey: (k: string) => Uint8Array }> | undefined;
let idbBase: string | undefined;

/** Load the SDK once, after silencing its loggers (child loggers copy the level at creation). */
async function loadSdk(storeDir: string, level: string) {
  if (!idbBase) {
    const { default: setGlobalVars } = (await import('indexeddbshim')) as Any;
    setGlobalVars(globalThis, { checkOrigin: false, databaseBasePath: storeDir, deleteDatabaseFiles: false });
    idbBase = storeDir;
  } else if (idbBase !== storeDir) throw new Error('one crypto store per process');
  sdkPromise ??= (async () => {
    const { logger } = (await import('matrix-js-sdk/lib/logger.js')) as Any;
    logger.setLevel(level);
    const sdk = await import('matrix-js-sdk');
    const { decodeRecoveryKey } = (await import('matrix-js-sdk/lib/crypto-api/index.js')) as Any;
    return { sdk, decodeRecoveryKey };
  })();
  return sdkPromise;
}

export interface OpenOptions {
  config: Config;
  endpoints: Endpoints;
  tokens: TokenSource;
  tom?: TomClient;
  log: Log;
  sdkLogLevel?: string;
}

export class MatrixChat implements ChatService {
  private names = new Map<string, string>();
  private myNames: string[] = [];
  private bootstrap: { imported?: number } = {};
  private refreshTimer?: NodeJS.Timeout;
  private index?: SearchIndex;
  private backfilling = false;
  private stopped = false;

  private constructor(
    private readonly sdk: Sdk,
    private readonly client: Any,
    private readonly opts: OpenOptions,
    private readonly lock: { release(): void },
    private readonly deviceId: string,
  ) {}

  static async open(opts: OpenOptions): Promise<MatrixChat> {
    const { config, endpoints, tokens, log } = opts;
    process.umask(0o077);
    mkdirSync(config.storeDir, { recursive: true, mode: 0o700 });
    const lock = acquireStoreLock(config.storeDir);
    try {
      const session = await tokens.getSession();
      if (session.userId && session.userId !== config.userId) {
        throw new Error(`the token belongs to ${session.userId}, not MATRIX_USER_ID ${config.userId}`);
      }
      const storageKey = loadOrCreateStoreKey(config.storeKeyFile);
      const { sdk, decodeRecoveryKey } = await loadSdk(config.storeDir, opts.sdkLogLevel ?? 'error');

      let recoveryKey: Uint8Array | undefined;
      let ssssKeyId: string | undefined;
      const client = sdk.createClient({
        baseUrl: endpoints.homeserverUrl,
        accessToken: session.accessToken,
        refreshToken: 'broker', // any value: makes the SDK call tokenRefreshFunction on 401
        userId: config.userId,
        deviceId: session.deviceId,
        tokenRefreshFunction: async () => {
          tokens.invalidate();
          const s = await tokens.getSession();
          return { accessToken: s.accessToken, refreshToken: 'broker', expiry: s.expiresAt ? new Date(s.expiresAt) : undefined };
        },
        cryptoCallbacks: {
          getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) =>
            recoveryKey && ssssKeyId && keys[ssssKeyId] ? [ssssKeyId, recoveryKey] : null,
        },
      });
      const chat = new MatrixChat(sdk, client, opts, lock, session.deviceId);

      await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: 'mcp-twake-chat', storageKey });
      chat.startTokenRefresh();
      await chat.startSync();

      if (config.recovery.mode !== 'off') {
        const words = async () => {
          if (config.recovery.mode === 'key') return readFileSync(config.recovery.keyFile, 'utf8').trim();
          if (!opts.tom) throw new Error('MATRIX_E2EE_RECOVERY=tom needs a ToM server (TOM_URL or discovery)');
          const w = await opts.tom.recoveryWords();
          if (!w) throw new Error('no recovery key in the ToM vault: set up chat backup in Twake Chat, or use MATRIX_E2EE_RECOVERY=key');
          return w;
        };
        await chat
          .ensureKeys(async () => {
            ssssKeyId = await client.secretStorage.getDefaultKeyId();
            const keyInfo = ssssKeyId ? (await client.secretStorage.getKey(ssssKeyId))?.[1] : undefined;
            if (!keyInfo) throw new Error('this account has no secret storage (SSSS)');
            const k = decodeRecoveryKey(await words());
            if (!(await client.secretStorage.checkKey(k, keyInfo))) throw new Error('the recovery key does not unlock the secret storage');
            recoveryKey = k;
          }, () => {
            recoveryKey = undefined;
          })
          .catch((e: Error) => log('warn', `encryption bootstrap incomplete: ${e.message} (older encrypted messages may stay unreadable)`));
      }
      await chat.loadMyNames();
      chat.startIndex();
      log('info', `connected as ${config.userId} (device ${session.deviceId}), ${chat.rooms().length} rooms`);
      return chat;
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  private startTokenRefresh(): void {
    this.refreshTimer = setInterval(async () => {
      try {
        const token = await this.opts.tokens.getToken();
        if (token !== this.client.getAccessToken()) this.client.setAccessToken(token);
      } catch (e) {
        this.opts.log('warn', `token refresh failed: ${(e as Error).message}`);
      }
    }, 30_000);
    this.refreshTimer.unref();
  }

  private startSync(): Promise<void> {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('initial sync took more than 180 s')), 180_000);
      this.client.on(this.sdk.ClientEvent.Sync, (state: string) => {
        if (state === 'PREPARED') {
          clearTimeout(to);
          resolve();
        }
      });
      this.client.startClient({ initialSyncLimit: 5, lazyLoadMembers: true });
    });
  }

  /** Import missing secrets (cross-signing, backup key) once; later starts use the local store. */
  private async ensureKeys(unlock: () => Promise<void>, lockAgain: () => void): Promise<void> {
    const crypto = this.client.getCrypto();
    const cs = await crypto.getCrossSigningStatus();
    const cached = cs.privateKeysCachedLocally;
    const haveCrossSigning = Boolean(cached.masterKey && cached.selfSigningKey && cached.userSigningKey);
    const haveBackupKey = Boolean(await crypto.getSessionBackupPrivateKey());
    if (haveCrossSigning && haveBackupKey) {
      await crypto.checkKeyBackupAndEnable();
      return;
    }
    await unlock();
    try {
      if (!haveCrossSigning && cs.privateKeysInSecretStorage) {
        await crypto.bootstrapCrossSigning({}); // imports from SSSS; never resets (guarded above)
        await crypto.crossSignDevice(this.deviceId).catch(() => {});
      }
      if (!haveBackupKey) {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
        await crypto.checkKeyBackupAndEnable();
        const r = await crypto.restoreKeyBackup();
        this.bootstrap.imported = r.imported;
        this.opts.log('info', `key backup restored: ${r.imported}/${r.total} room keys`);
      }
    } finally {
      lockAgain();
    }
  }

  private async loadMyNames(): Promise<void> {
    try {
      const p = await this.client.getProfileInfo(this.opts.config.userId);
      const dn: string | undefined = p?.displayname;
      if (dn) {
        this.names.set(this.opts.config.userId, dn);
        this.myNames = [dn, dn.split(' ')[0]].filter((n) => n.length > 3);
      }
    } catch {
      /* profile optional */
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.client.stopClient();
    await new Promise((r) => setTimeout(r, 1500)); // let IndexedDB flush
    this.index?.close();
    this.lock.release();
  }

  // ---------------------------------------------------------------- local search index

  /** Index live messages of encrypted rooms, then catch up and backfill their history in the background. */
  private startIndex(): void {
    const s = this.opts.config.search;
    if (!s.enabled) return;
    this.index = SearchIndex.open(s.file);
    const { RoomEvent, MatrixEventEvent } = this.sdk;
    this.client.on(RoomEvent.Timeline, (ev: Any, room: Any, toStart: boolean, _removed: boolean, data: Any) => {
      if (toStart || !data?.liveEvent || !room) return;
      this.indexLive(room.roomId, ev);
    });
    this.client.on(MatrixEventEvent.Decrypted, (ev: Any) => {
      const roomId = ev.getRoomId();
      if (roomId) this.indexLive(roomId, ev);
    });
    this.client.on(RoomEvent.Redaction, (ev: Any) => {
      const id = ev.event?.redacts ?? ev.getContent()?.redacts;
      if (id) this.index?.remove(id);
    });
    const cutoff = s.backfillDays > 0 ? Date.now() - s.backfillDays * 86400000 : Infinity;
    this.backfill(cutoff).catch((e: Error) => this.opts.log('warn', `search backfill stopped: ${e.message}`));
  }

  private isEncrypted(roomId: string): boolean {
    return Boolean(this.client.getRoom(roomId)?.hasEncryptionStateEvent());
  }

  private viewOf(roomId: string, e: Any): MessageView {
    const ctx = { names: (id: string) => this.names.get(id) ?? this.client.getRoom(roomId)?.getMember(id)?.name ?? id, me: this.opts.config.userId, myNames: this.myNames };
    const raw: RawEvent = {
      event_id: e.getId(),
      sender: e.getSender(),
      type: e.getType(),
      origin_server_ts: e.getTs(),
      content: e.getContent() ?? {},
      unsigned: e.getUnsigned(),
    };
    return messageFromEvent(raw, e.isDecryptionFailure() ? { ...ctx, undecryptable: e.decryptionFailureReason ?? 'UNKNOWN' } : ctx);
  }

  private indexLive(roomId: string, ev: Any): void {
    if (!this.index || !this.isEncrypted(roomId)) return;
    if (ev.getType() === 'm.room.encrypted' || ev.isDecryptionFailure?.() || !MESSAGE_TYPES.has(ev.getType())) return; // indexed once decrypted
    try {
      this.index.add(roomId, [this.viewOf(roomId, ev)]);
    } catch (e) {
      this.opts.log('warn', `search index: ${(e as Error).message}`);
    }
  }

  /** Per encrypted room, newest first: catch up on messages missed while stopped, then go back in history to `cutoff`. */
  private async backfill(cutoff: number): Promise<void> {
    const index = this.index!;
    this.backfilling = true;
    const pause = () => new Promise((r) => setTimeout(r, 250));
    try {
      const rooms = this.rooms()
        .filter((r) => r.encrypted && r.kind !== 'space')
        .sort((a, b) => b.lastActivity - a.lastActivity);
      for (const room of rooms) {
        const newest = index.newestTs(room.id);
        if (newest !== undefined && room.lastActivity > newest) {
          let from: string | null = null;
          for (let page = 0; page < 50 && !this.stopped; page++) {
            const res: Any = await this.client.createMessagesRequest(room.id, from, 100, this.sdk.Direction.Backward);
            const chunk = res.chunk as Any[];
            const fresh = chunk.filter((e) => MESSAGE_TYPES.has(e.type) && e.origin_server_ts >= newest);
            if (fresh.length) index.add(room.id, await this.views(room.id, fresh));
            if (!res.end || chunk.length === 0 || chunk.some((e) => e.origin_server_ts < newest)) break;
            from = res.end;
            await pause();
          }
        }
        let p = index.progress(room.id);
        if (cutoff === Infinity && newest === undefined) {
          index.setProgress(room.id, { token: null, complete: true });
          continue;
        }
        for (let page = 0; !p.complete && page < 500 && !this.stopped; page++) {
          const res = await this.client.createMessagesRequest(room.id, p.token, 100, this.sdk.Direction.Backward);
          const chunk = res.chunk as Any[];
          const msgs = chunk.filter((e) => MESSAGE_TYPES.has(e.type) && e.origin_server_ts >= cutoff);
          if (msgs.length) index.add(room.id, await this.views(room.id, msgs));
          const oldestTs: number | undefined = chunk.length ? chunk[chunk.length - 1].origin_server_ts : p.oldestTs;
          p = { token: res.end ?? null, complete: !res.end || chunk.length === 0 || (oldestTs !== undefined && oldestTs < cutoff), oldestTs };
          index.setProgress(room.id, p);
          await pause();
        }
        if (this.stopped) return;
      }
      const st = index.stats();
      this.opts.log('info', `search index ready: ${st.messages} messages`);
    } finally {
      this.backfilling = false;
    }
  }

  async searchMessages(q: SearchRequest): Promise<SearchResult> {
    const all = this.rooms().filter((r) => r.kind !== 'space');
    const names = new Map(all.map((r) => [r.id, r.name]));
    const scope = q.roomIds ? all.filter((r) => q.roomIds!.includes(r.id)) : all;
    const enc = scope.filter((r) => r.encrypted).map((r) => r.id);
    const clear = scope.filter((r) => !r.encrypted).map((r) => r.id);

    let local: SearchHit[] = [];
    if (this.index && enc.length) {
      const found = this.index.search({ ...q, roomIds: enc, limit: q.limit + 10 });
      // drop messages deleted since they were indexed (deletions are not seen while the server is stopped)
      const alive = await mapLimit(found, 6, async (h) => {
        const ev = await this.client.fetchRoomEvent(h.roomId, h.id).catch(() => undefined);
        const gone = !ev || ev.unsigned?.redacted_because || Object.keys(ev.content ?? {}).length === 0;
        if (gone) this.index?.remove(h.id);
        return gone ? undefined : h;
      });
      local = alive.filter((h): h is SearchHit => Boolean(h));
    }

    let server: SearchHit[] = [];
    if (clear.length) {
      const filter: Record<string, unknown> = { rooms: clear, limit: q.limit };
      if (q.sender) filter.senders = [q.sender];
      const res = await this.client.search({ body: { search_categories: { room_events: { search_term: q.text, order_by: 'recent', filter } } } });
      const raws = ((res.search_categories?.room_events?.results ?? []) as Any[]).map((r) => r.result).filter((e) => e && MESSAGE_TYPES.has(e.type));
      const inRange = raws.filter((e) => (q.since === undefined || e.origin_server_ts >= q.since) && (q.until === undefined || e.origin_server_ts < q.until));
      for (const e of inRange) {
        const [v] = await this.views(e.room_id, [e]);
        if (!v.body || v.kind === 'deleted') continue;
        const hit: SearchHit = { id: v.id, roomId: e.room_id, sender: v.sender, senderName: v.senderName, ts: v.ts, body: v.body };
        if (v.threadRoot) hit.threadRoot = v.threadRoot;
        server.push(hit);
      }
    }

    const seen = new Set<string>();
    const hits = [...local, ...server]
      .filter((h) => !seen.has(h.id) && seen.add(h.id))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, q.limit)
      .map((h) => ({ ...h, roomName: names.get(h.roomId) ?? h.roomId }));
    const out: SearchResult = { hits, serverRooms: clear.length };
    if (this.index) {
      const encAll = all.filter((r) => r.encrypted);
      out.index = {
        messages: this.index.stats().messages,
        rooms: encAll.length,
        completeRooms: encAll.filter((r) => this.index!.progress(r.id).complete).length,
        backfilling: this.backfilling,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- rooms

  invitations(): Invitation[] {
    const me = this.opts.config.userId;
    return this.client
      .getRooms()
      .filter((r: Any) => r.getMyMembership() === 'invite')
      .map((r: Any): Invitation => {
        const ev = r.getMember(me)?.events?.member;
        const inv: Invitation = { roomId: r.roomId, name: r.name, direct: Boolean(ev?.getContent()?.is_direct) };
        const inviter: string | undefined = ev?.getSender();
        if (inviter) {
          inv.inviter = inviter;
          const n = r.getMember(inviter)?.name;
          if (n && n !== inviter) inv.inviterName = n;
        }
        if (ev?.getTs()) inv.ts = ev.getTs();
        return inv;
      });
  }

  private async addDirect(userId: string, roomId: string): Promise<void> {
    const content = { ...(this.client.getAccountData('m.direct')?.getContent() ?? {}) } as Record<string, string[]>;
    const list = new Set(content[userId] ?? []);
    if (list.has(roomId)) return;
    list.add(roomId);
    content[userId] = [...list];
    await this.client.setAccountData('m.direct', content);
  }

  private async waitRoom(roomId: string, membership: string, ready: (room: Any) => boolean = () => true): Promise<Any> {
    for (let i = 0; i < 80; i++) {
      const r = this.client.getRoom(roomId);
      if (r && r.getMyMembership() === membership && ready(r)) return r;
      await new Promise((res) => setTimeout(res, 250));
    }
    return undefined;
  }

  async joinRoom(idOrAlias: string): Promise<{ roomId: string; name: string }> {
    const invite = this.invitations().find((i) => i.roomId === idOrAlias);
    const joined = await this.client.joinRoom(idOrAlias);
    const room = await this.waitRoom(joined.roomId, 'join');
    if (invite?.direct && invite.inviter) await this.addDirect(invite.inviter, joined.roomId);
    return { roomId: joined.roomId, name: room?.name ?? invite?.name ?? joined.roomId };
  }

  async leaveRoom(roomId: string): Promise<void> {
    this.joined(roomId);
    await this.client.leave(roomId);
  }

  async createRoom(r: NewRoom): Promise<{ roomId: string }> {
    const opts: Record<string, unknown> = {
      preset: r.direct ? this.sdk.Preset.TrustedPrivateChat : this.sdk.Preset.PrivateChat,
      visibility: this.sdk.Visibility.Private,
      invite: r.invite,
      is_direct: r.direct,
      initial_state: r.encrypted ? [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] : [],
    };
    if (r.name) opts.name = r.name;
    if (r.topic) opts.topic = r.topic;
    const res = await this.client.createRoom(opts);
    if (r.direct && r.invite[0]) await this.addDirect(r.invite[0], res.room_id);
    // a message sent before the client knows the room is encrypted would go out in clear
    const room = await this.waitRoom(res.room_id, 'join', (x) => !r.encrypted || x.hasEncryptionStateEvent());
    if (!room) throw new Error(`room ${res.room_id} was created but is not synced yet: wait a few seconds before posting in it`);
    return { roomId: res.room_id };
  }

  async invite(roomId: string, userId: string): Promise<void> {
    this.joined(roomId);
    await this.client.invite(roomId, userId);
  }

  // ---------------------------------------------------------------- ChatService

  identity(): Identity {
    return {
      userId: this.opts.config.userId,
      deviceId: this.deviceId,
      displayName: this.names.get(this.opts.config.userId),
      homeserverUrl: this.opts.endpoints.homeserverUrl,
    };
  }

  async encryption(): Promise<EncryptionStatus> {
    const crypto = this.client.getCrypto();
    const cs = await crypto.getCrossSigningStatus();
    const c = cs.privateKeysCachedLocally;
    const v = await crypto.getDeviceVerificationStatus(this.opts.config.userId, this.deviceId);
    const status: EncryptionStatus = {
      crossSigningReady: Boolean(c.masterKey && c.selfSigningKey && c.userSigningKey),
      deviceVerified: Boolean(v?.crossSigningVerified || v?.signedByOwner),
    };
    const version = await crypto.getActiveSessionBackupVersion();
    if (version) status.keyBackupVersion = version;
    if (this.bootstrap.imported !== undefined) status.roomKeysImported = this.bootstrap.imported;
    return status;
  }

  private directMap(): Map<string, string> {
    const m = new Map<string, string>();
    const content = this.client.getAccountData('m.direct')?.getContent() ?? {};
    for (const [userId, roomIds] of Object.entries(content)) for (const id of roomIds as string[]) m.set(id, userId);
    return m;
  }

  rooms(): RoomView[] {
    const direct = this.directMap();
    const { NotificationCountType } = this.sdk;
    return this.client
      .getRooms()
      .filter((r: Any) => r.getMyMembership() === 'join')
      .map((r: Any): RoomView => {
        const dmUserId = direct.get(r.roomId);
        const view: RoomView = {
          id: r.roomId,
          name: r.name,
          kind: r.isSpaceRoom() ? 'space' : dmUserId ? 'dm' : 'group',
          encrypted: r.hasEncryptionStateEvent(),
          members: r.getJoinedMemberCount(),
          unread: this.hasUnread(r),
          notifications: r.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
          highlights: r.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0,
          lastActivity: r.getLastActiveTimestamp() > 0 ? r.getLastActiveTimestamp() : 0,
        };
        const alias = r.getCanonicalAlias();
        if (alias) view.alias = alias;
        const topic = r.currentState.getStateEvents('m.room.topic', '')?.getContent()?.topic;
        if (topic) view.topic = topic;
        if (dmUserId) view.dmUserId = dmUserId;
        return view;
      });
  }

  /**
   * Server notification counts are 0 when push rules mute rooms (the case on Twake),
   * so unread = the latest message-like event is from someone else and not covered by
   * the user's read receipt (as Twake Chat computes it client-side).
   */
  private hasUnread(room: Any): boolean {
    const me = this.opts.config.userId;
    const events = room.getLiveTimeline().getEvents() as Any[];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!MESSAGE_TYPES.has(e.getWireType?.() ?? e.getType())) continue;
      if (e.getSender() === me || room.hasUserReadEvent(me, e.getId())) return false;
      // the read marker (m.fully_read) at or after this message also counts as read
      const marker = room.getAccountData('m.fully_read')?.getContent()?.event_id;
      const at = marker ? events.findIndex((x) => x.getId() === marker) : -1;
      return at < i;
    }
    return false;
  }

  async members(roomId: string, limit: number): Promise<Member[]> {
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error(`not a member of ${roomId}`);
    await room.loadMembersIfNeeded();
    return room
      .getMembers()
      .filter((m: Any) => m.membership === 'join' || m.membership === 'invite')
      .slice(0, limit)
      .map((m: Any) => ({ userId: m.userId, name: m.name, membership: m.membership }));
  }

  private async nameOf(roomId: string, userId: string): Promise<string> {
    const member = this.client.getRoom(roomId)?.getMember(userId);
    if (member?.name && member.name !== userId) return member.name;
    if (this.names.has(userId)) return this.names.get(userId)!;
    let name = userId;
    try {
      name = (await this.client.getProfileInfo(userId))?.displayname ?? userId;
    } catch {
      /* unknown profile */
    }
    this.names.set(userId, name);
    return name;
  }

  /** Decrypt raw events (retrying once those whose key may arrive from the backup) and build views. */
  private async views(roomId: string, raws: Any[]): Promise<MessageView[]> {
    const events = raws.map((r) => new this.sdk.MatrixEvent({ ...r, room_id: roomId }));
    await Promise.all(events.map((e: Any) => this.client.decryptEventIfNeeded(e)));
    const retry = events.filter((e: Any) => e.isDecryptionFailure() && RETRYABLE.has(e.decryptionFailureReason));
    if (retry.length) {
      await new Promise((r) => setTimeout(r, 1500));
      await Promise.all(retry.map((e: Any) => e.attemptDecryption(this.client.getCrypto(), { isRetry: true })));
    }
    for (const e of events) await this.nameOf(roomId, e.getSender());
    const out = events.map((e: Any) => this.viewOf(roomId, e));
    if (this.index && this.isEncrypted(roomId)) {
      try {
        this.index.add(roomId, out); // whatever is read gets indexed
      } catch (e) {
        this.opts.log('warn', `search index: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async messages(roomId: string, q: MessageQuery): Promise<Page> {
    if (!this.client.getRoom(roomId)) throw new Error(`not a member of ${roomId}`);
    const collected: Any[] = [];
    let from: string | null = q.before ?? null;
    let next: string | undefined;
    let done = false;
    for (let page = 0; page < 40 && !done; page++) {
      const need = q.limit - collected.filter((e) => !isEdit(e)).length;
      if (need <= 0) break;
      // ask only for what is missing: a page never holds more messages than needed, so the cursor skips nothing
      const res = await this.client.createMessagesRequest(roomId, from, need, this.sdk.Direction.Backward);
      for (const e of res.chunk as Any[]) {
        if (q.since !== undefined && e.origin_server_ts < q.since) {
          done = true;
          break;
        }
        if (q.until !== undefined && e.origin_server_ts >= q.until) continue;
        if (MESSAGE_TYPES.has(e.type)) collected.push(e);
      }
      next = res.end;
      if (!res.end || res.chunk.length === 0) {
        next = undefined;
        done = true;
      }
      from = res.end;
    }
    const views = applyEdits((await this.views(roomId, collected)).reverse());
    const messages = views.slice(-q.limit);
    return done ? { messages } : { messages, next };
  }

  async thread(roomId: string, rootId: string, limit: number): Promise<MessageView[]> {
    const root = await this.client.fetchRoomEvent(roomId, rootId);
    const rel = await this.client.fetchRelations(roomId, rootId, 'm.thread', null, { dir: this.sdk.Direction.Backward, limit });
    const raws = [root, ...[...(rel.chunk as Any[])].reverse()].filter((e) => MESSAGE_TYPES.has(e.type));
    return applyEdits(await this.views(roomId, raws));
  }

  async unread(perRoom: number, maxRooms: number, kind?: RoomView['kind']): Promise<UnreadRoom[]> {
    const me = this.opts.config.userId;
    const rooms = this.rooms()
      .filter((r) => r.unread && (!kind || r.kind === kind))
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, maxRooms);
    return mapLimit(rooms, 4, async (room) => {
      // messages after the event the user has read up to (its timestamp, not the receipt's)
      const r = this.client.getRoom(room.id);
      const readId: string | null = r?.getEventReadUpTo(me) ?? null;
      let readTs: number | undefined;
      if (readId) {
        readTs = r.findEventById(readId)?.getTs();
        if (readTs === undefined) readTs = (await this.client.fetchRoomEvent(room.id, readId).catch(() => undefined))?.origin_server_ts;
      }
      const q: MessageQuery = readTs !== undefined ? { limit: perRoom + 1, since: readTs + 1 } : { limit: perRoom + 1 };
      const page = await this.messages(room.id, q);
      const others = page.messages.filter((m) => m.sender !== me);
      return { room, messages: others.slice(-perRoom), truncated: others.length > perRoom };
    });
  }

  async mentions(sinceMs: number, limit: number): Promise<MentionHit[]> {
    const me = this.opts.config.userId;
    const rooms = this.rooms()
      .filter((r) => r.lastActivity >= sinceMs && r.kind !== 'space')
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 60);
    const perRoom = await mapLimit(rooms, 4, async (room) => {
      const page = await this.messages(room.id, { limit: 100, since: sinceMs });
      return page.messages.filter((m) => m.mentionsMe && m.sender !== me).map((message) => ({ room, message }));
    });
    return perRoom
      .flat()
      .sort((a, b) => b.message.ts - a.message.ts)
      .slice(0, limit);
  }

  private async draftsRoomId(): Promise<string> {
    const ok = (id?: string) => {
      const r = id ? this.client.getRoom(id) : undefined;
      return r && r.getMyMembership() === 'join' && r.getJoinedMemberCount() === 1 && r.getInvitedMemberCount() === 0 ? r : undefined;
    };
    const saved: string | undefined = this.client.getAccountData(DRAFTS_ACCOUNT_DATA)?.getContent()?.room_id;
    if (ok(saved)) return saved!;
    const name = this.opts.config.draftsRoomName;
    const existing = this.client.getRooms().find((r: Any) => r.name === name && ok(r.roomId) && r.hasEncryptionStateEvent());
    let id: string = existing?.roomId;
    if (!id) {
      const res = await this.client.createRoom({
        name,
        topic: 'Drafts written by your assistant (mcp-twake-chat). You are the only member: nothing here is sent to anyone.',
        preset: this.sdk.Preset.PrivateChat,
        visibility: this.sdk.Visibility.Private,
        initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
      });
      id = res.room_id;
      for (let i = 0; i < 40 && !this.client.getRoom(id); i++) await new Promise((r) => setTimeout(r, 250));
    }
    await this.client.setAccountData(DRAFTS_ACCOUNT_DATA, { room_id: id });
    return id;
  }

  async postDraft(text: string, target?: RoomView): Promise<{ roomId: string; roomName: string; eventId: string }> {
    const roomId = await this.draftsRoomId();
    const room = this.client.getRoom(roomId);
    // Hard guard: drafts only ever go to a private room whose only member is the user.
    if (!room || room.getJoinedMemberCount() !== 1 || room.getInvitedMemberCount() !== 0) {
      throw new Error('the drafts room is not private (other members): refusing to post');
    }
    const body = target ? `✏️ ${target.name}${target.dmUserId ? ` (${target.dmUserId})` : ''}\n\n${text}` : text;
    const res = await this.client.sendMessage(roomId, textContent(body));
    return { roomId, roomName: room.name, eventId: res.event_id };
  }

  // ---------------------------------------------------------------- v0.2 write tools

  private joined(roomId: string): Any {
    const room = this.client.getRoom(roomId);
    if (!room || room.getMyMembership() !== 'join') throw new Error(`not a member of ${roomId}`);
    return room;
  }

  /** Fetch one event and decrypt it. */
  private async fetchEvent(roomId: string, eventId: string): Promise<Any> {
    const raw = await this.client.fetchRoomEvent(roomId, eventId);
    const ev = new this.sdk.MatrixEvent({ ...raw, room_id: roomId });
    await this.client.decryptEventIfNeeded(ev);
    return ev;
  }

  private async ownMessage(roomId: string, eventId: string): Promise<Any> {
    const ev = await this.fetchEvent(roomId, eventId);
    if (ev.getSender() !== this.opts.config.userId) throw new Error('only your own messages can be edited or deleted');
    if (ev.isRedacted?.() || Object.keys(ev.getContent() ?? {}).length === 0) throw new Error('this message is already deleted');
    return ev;
  }

  async sendMessage(roomId: string, text: string, opts: { replyTo?: string; threadRoot?: string; mentions?: string[] }): Promise<{ eventId: string }> {
    this.joined(roomId);
    const res = await this.client.sendMessage(roomId, textContent(text, opts));
    return { eventId: res.event_id };
  }

  async react(roomId: string, eventId: string, key: string): Promise<{ eventId: string }> {
    this.joined(roomId);
    const res = await this.client.sendEvent(roomId, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } });
    return { eventId: res.event_id };
  }

  async editMessage(roomId: string, eventId: string, text: string): Promise<{ eventId: string }> {
    this.joined(roomId);
    const ev = await this.ownMessage(roomId, eventId);
    if (ev.getType() !== 'm.room.message' || !['m.text', 'm.notice', 'm.emote'].includes(ev.getContent()?.msgtype)) {
      throw new Error('only text messages can be edited');
    }
    const res = await this.client.sendMessage(roomId, editContent(eventId, text));
    return { eventId: res.event_id };
  }

  async redactMessage(roomId: string, eventId: string, reason?: string): Promise<{ eventId: string }> {
    this.joined(roomId);
    await this.ownMessage(roomId, eventId);
    const res = await this.client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
    return { eventId: res.event_id };
  }

  async sendFile(roomId: string, f: { path: string; name?: string; caption?: string }): Promise<{ eventId: string; name: string; size: number; encrypted: boolean }> {
    const room = this.joined(roomId);
    const size = statSync(f.path).size;
    const limit: number | undefined = (await this.client.getMediaConfig().catch(() => ({})))['m.upload.size'];
    if (limit && size > limit) throw new Error(`file too large (${size} bytes, server limit ${limit})`);
    const name = f.name ?? basename(f.path);
    const mimetype = guessMime(name);
    const bytes = new Uint8Array(readFileSync(f.path));
    const encrypted = room.hasEncryptionStateEvent();
    let content;
    if (encrypted) {
      const { ciphertext, file } = await encryptAttachment(bytes);
      const up = await this.client.uploadContent(new Blob([new Uint8Array(ciphertext)], { type: 'application/octet-stream' }), { type: 'application/octet-stream', includeFilename: false });
      content = fileContent({ name, mimetype, size, file: { ...file, url: up.content_uri }, ...(f.caption ? { caption: f.caption } : {}) });
    } else {
      const up = await this.client.uploadContent(new Blob([new Uint8Array(bytes)], { type: mimetype }), { type: mimetype, name, includeFilename: true });
      content = fileContent({ name, mimetype, size, url: up.content_uri, ...(f.caption ? { caption: f.caption } : {}) });
    }
    const res = await this.client.sendMessage(roomId, content);
    return { eventId: res.event_id, name, size, encrypted };
  }

  async downloadAttachment(roomId: string, eventId: string, dir: string): Promise<{ path: string; name: string; mimetype?: string; size: number }> {
    this.joined(roomId);
    const ev = await this.fetchEvent(roomId, eventId);
    if (ev.isDecryptionFailure()) throw new Error(`cannot decrypt this message (${ev.decryptionFailureReason})`);
    const c = ev.getContent() ?? {};
    const file = c.file;
    const mxc: string | undefined = file?.url ?? c.url;
    if (!mxc) throw new Error('this message has no attachment');
    const { server, mediaId } = parseMxc(mxc);
    const token = await this.opts.tokens.getToken();
    const base = this.opts.endpoints.homeserverUrl;
    const path = `${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`;
    let res = await fetch(`${base}/_matrix/client/v1/media/download/${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404 || res.status === 400) res = await fetch(`${base}/_matrix/media/v3/download/${path}`); // pre-authenticated-media servers
    if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (file) bytes = new Uint8Array(await decryptAttachment(bytes, file));
    const name = safeName(c.filename ?? c.body ?? mediaId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = uniquePath(dir, name);
    writeFileSync(target, bytes, { flag: 'wx' });
    return { path: target, name, mimetype: c.info?.mimetype, size: bytes.length };
  }
}

function isEdit(e: Any): boolean {
  return e.content?.['m.relates_to']?.rel_type === 'm.replace';
}

async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
