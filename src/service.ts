import type { MessageView, RoomView } from './format.js';
import type { SearchHit } from './search-index.js';
import type { DirectoryUser } from './tom.js';

export interface Member {
  userId: string;
  name: string;
  membership: string;
}

export interface Page {
  messages: MessageView[];
  /** cursor for older messages, absent at the start of the room */
  next?: string;
}

export interface MessageQuery {
  limit: number;
  /** pagination cursor returned by a previous call */
  before?: string;
  /** epoch ms bounds */
  since?: number;
  until?: number;
}

export interface UnreadRoom {
  room: RoomView;
  messages: MessageView[];
  /** true when more unread messages exist than returned */
  truncated: boolean;
}

export interface MentionHit {
  room: RoomView;
  message: MessageView;
}

export interface SearchRequest {
  text: string;
  roomIds?: string[];
  sender?: string;
  since?: number;
  until?: number;
  limit: number;
}

export interface SearchResult {
  hits: (SearchHit & { roomName: string })[];
  /** local index of encrypted rooms; absent when disabled */
  index?: { messages: number; rooms: number; completeRooms: number; backfilling: boolean };
  /** unencrypted rooms searched on the server */
  serverRooms: number;
}

export interface Invitation {
  roomId: string;
  name: string;
  inviter?: string;
  inviterName?: string;
  ts?: number;
  direct: boolean;
}

export interface NewRoom {
  name?: string;
  topic?: string;
  invite: string[];
  encrypted: boolean;
  direct: boolean;
}

export interface Identity {
  userId: string;
  deviceId: string;
  displayName?: string;
  homeserverUrl: string;
}

export interface EncryptionStatus {
  crossSigningReady: boolean;
  deviceVerified: boolean;
  keyBackupVersion?: string;
  roomKeysImported?: number;
}

/** What the tools need from the Matrix layer: implemented by MatrixChat, faked in tests. */
export interface ChatService {
  identity(): Identity;
  encryption(): Promise<EncryptionStatus>;
  rooms(): RoomView[];
  members(roomId: string, limit: number): Promise<Member[]>;
  messages(roomId: string, query: MessageQuery): Promise<Page>;
  thread(roomId: string, rootId: string, limit: number): Promise<MessageView[]>;
  unread(perRoom: number, maxRooms: number, kind?: RoomView['kind']): Promise<UnreadRoom[]>;
  mentions(sinceMs: number, limit: number): Promise<MentionHit[]>;
  /** Post a draft in the private drafts room; never in the target room. */
  postDraft(text: string, target?: RoomView): Promise<{ roomId: string; roomName: string; eventId: string }>;

  /** One message, decrypted (for the approval prompt that quotes it); undefined if it cannot be read. */
  message(roomId: string, eventId: string): Promise<MessageView | undefined>;

  // ---- write tools (v0.2): they act in the user's name, visible to the room members
  sendMessage(roomId: string, text: string, opts: { replyTo?: string; threadRoot?: string; mentions?: string[] }): Promise<{ eventId: string }>;
  react(roomId: string, eventId: string, key: string): Promise<{ eventId: string }>;
  /** Only the user's own messages. */
  editMessage(roomId: string, eventId: string, text: string): Promise<{ eventId: string }>;
  /** Only the user's own messages. */
  redactMessage(roomId: string, eventId: string, reason?: string): Promise<{ eventId: string }>;
  sendFile(roomId: string, file: { path: string; name?: string; caption?: string }): Promise<{ eventId: string; name: string; size: number; encrypted: boolean }>;
  // ---- v0.3
  /** Full-text search: local index (encrypted rooms) + server search (unencrypted rooms). */
  searchMessages(q: SearchRequest): Promise<SearchResult>;
  invitations(): Invitation[];
  /** Accept an invitation or join a public room (id or alias). */
  joinRoom(idOrAlias: string): Promise<{ roomId: string; name: string }>;
  leaveRoom(roomId: string): Promise<void>;
  createRoom(r: NewRoom): Promise<{ roomId: string }>;
  invite(roomId: string, userId: string): Promise<void>;

  /** Download (and decrypt) the attachment of a message into a local directory. */
  downloadAttachment(roomId: string, eventId: string, dir: string): Promise<{ path: string; name: string; mimetype?: string; size: number }>;
}

export interface Directory {
  searchUsers(query: string, limit?: number): Promise<DirectoryUser[]>;
  userInfo(userId: string): Promise<DirectoryUser | null>;
}
