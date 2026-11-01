/**
 * MatrixChat: the real ChatService, on matrix-js-sdk with the Rust crypto (WASM)
 * and a persistent, encrypted IndexedDB store emulated on SQLite (indexeddbshim).
 *
 * Start-up order (validated by spikes 001-002):
 *   lock store -> crypto from store -> initial sync -> if keys missing locally:
 *   recovery key (ToM vault or file) -> SSSS -> cross-signing import + sign this device
 *   -> backup key -> restore backup.  Then a live sync keeps receiving room keys.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import type { Config } from './config.js';
import type { Endpoints } from './discovery.js';
import { applyEdits, messageFromEvent, type MessageView, type RawEvent, type RoomView } from './format.js';
import type { ChatService, EncryptionStatus, Identity, Member, MentionHit, MessageQuery, Page, UnreadRoom } from './service.js';
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
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.client.stopClient();
    await new Promise((r) => setTimeout(r, 1500)); // let IndexedDB flush
    this.lock.release();
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
    const ctx = { names: (id: string) => this.names.get(id) ?? this.client.getRoom(roomId)?.getMember(id)?.name ?? id, me: this.opts.config.userId, myNames: this.myNames };
    return events.map((e: Any) => {
      const raw: RawEvent = {
        event_id: e.getId(),
        sender: e.getSender(),
        type: e.getType(),
        origin_server_ts: e.getTs(),
        content: e.getContent() ?? {},
        unsigned: e.getUnsigned(),
      };
      return messageFromEvent(raw, e.isDecryptionFailure() ? { ...ctx, undecryptable: e.decryptionFailureReason ?? 'UNKNOWN' } : ctx);
    });
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
    const res = await this.client.sendMessage(roomId, { msgtype: 'm.text', body });
    return { roomId, roomName: room.name, eventId: res.event_id };
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
