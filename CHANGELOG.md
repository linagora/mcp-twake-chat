# Changelog

All notable changes to mcp-twake-chat are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-11-01

### Added
- Prior approval of every action in the user's name, asked by the server itself through MCP elicitation (`MATRIX_APPROVAL=elicit`, the default): `send_message`, `react`, `edit_message`, `redact_message`, `send_file`, `join_room`, `leave_room`, `create_room` and `invite_user` show the room (direct message, group room or space, members, encryption), the quoted message they answer or change, the exact text, file or invitees and a unique reference, and act only on accept. Prompts in English or French (`USER_LANGUAGE`), `MATRIX_APPROVAL_TIMEOUT_MS`. Reads, searches, downloads and drafts need no approval.
- HTTP sessions (`Mcp-Session-Id`): the approval prompt sent during a tool call reaches the right client and its answer comes back. Requests without a session are still served statelessly.
- `scripts/live-write.mjs` answers the approval prompts and checks that a refused message is not sent.

### Changed
- **Breaking**: with an MCP client that does not support elicitation, write tools now return an error and send nothing. Set `MATRIX_APPROVAL=client` to keep the 0.4 behaviour when your client confirms writes itself.

## [0.4.0] - 2026-11-01

### Added
- `MATRIX_SEND_SCOPE=dm`: the write tools (`send_message`, `react`, `edit_message`, `redact_message`, `send_file`) refuse every room that is not a direct message, and say so in their descriptions.

## [0.3.0] - 2026-11-01

### Added
- `search_messages`: full-text search in every room, end-to-end encrypted ones included, through a local SQLite FTS5 index of decrypted messages (live indexing, background backfill of `MATRIX_SEARCH_BACKFILL_DAYS`, catch-up after a restart, deleted messages dropped) combined with the homeserver search for unencrypted rooms. `MATRIX_SEARCH_INDEX=off` disables the index.
- `list_invitations`; room management acting in the user's name: `create_room` (private, encrypted by default, or a direct message), `invite_user`, `join_room`, `leave_room`.

### Changed
- Node.js >= 22.13 (built-in `node:sqlite`).
- TypeScript 7, actions/checkout and actions/setup-node v7.

### Fixed
- `create_room` returns only once the client knows the new room is encrypted, so a message posted right after it is never sent in clear.

## [0.2.0] - 2026-11-01

### Added
- Write tools, acting in the user's name: `send_message` (Markdown rendered to HTML, replies, threads, mentions), `react`, `edit_message` and `redact_message` (own messages only), `send_file` (encrypted upload in end-to-end encrypted rooms).
- `download_attachment`: saves the file of a message, decrypting encrypted attachments (authenticated media endpoint, never overwrites a local file); `MATRIX_DOWNLOAD_DIR`.
- Drafts rendered from Markdown.

### Fixed
- A deleted (redacted) encrypted message is reported as deleted, not undecryptable, and its earlier edits no longer bring its text back.

## [0.1.0] - 2026-11-01

### Added
- 11 tools: `whoami`, `list_rooms`, `get_room_info`, `list_room_members`, `get_messages`, `get_thread`, `get_unread`, `get_mentions`, `search_users`, `get_user_profile`, `create_draft`.
- End-to-end encryption with the Rust crypto of matrix-js-sdk and a persistent, encrypted store; recovery key from the Twake ToM vault or a file; cross-signing import and device signing; key backup restore.
- Unread messages from read receipts and read markers; mentions found client-side in encrypted rooms.
- Drafts posted only in a private drafts room.
- Authentication through an external token broker (`MATRIX_TOKEN_COMMAND`, with device id).
- Discovery of the homeserver and ToM server from `.well-known/matrix/client`.
- stdio and HTTP (loopback, bearer token) transports; exclusive lock on the device store; `check` command.
