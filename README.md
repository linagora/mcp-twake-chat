# mcp-twake-chat

[![CI](https://github.com/linagora/mcp-twake-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/mcp-twake-chat/actions/workflows/ci.yml) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE) [![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)

**Give your AI assistant secure access to Twake Chat, the Matrix messaging of the [Twake.ai](https://twake.ai) Digital Workplace, end-to-end encrypted rooms included.**

## What is it?

`mcp-twake-chat` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. MCP is the open standard that lets AI assistants (Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code and many others) use external tools. This server exposes your chat to the assistant as **23 tools**: rooms, messages, threads, unread messages, mentions, full-text search (encrypted rooms included), people, attachments, drafts and, when you allow it, sending and room management.

It speaks the open [Matrix](https://spec.matrix.org) Client-Server API through [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk) and its Rust cryptography, so it reads **end-to-end encrypted** rooms like any Matrix client. It works with Twake Chat and with any Matrix homeserver (Synapse, Conduit…); the Twake-specific extras (company directory, recovery vault) come from the [ToM server](https://github.com/linagora/ToM-Server).

## Part of Twake.ai

[Twake.ai](https://twake.ai) is the truly open source and sovereign Digital Workplace developed by [LINAGORA](https://linagora.com): Twake Mail, Twake Calendar, Twake Drive, Twake Chat and Twake Visio with a single account, hosted in France or on your own infrastructure.

| MCP server | Twake.ai service | Protocol |
|---|---|---|
| [mcp-twake-mail](https://github.com/linagora/mcp-twake-mail) | Twake Mail | JMAP |
| [mcp-twake-dav](https://github.com/linagora/mcp-twake-dav) | Twake Calendar and contacts | CalDAV / CardDAV |
| [mcp-twake-drive](https://github.com/linagora/mcp-twake-drive) | Twake Drive | cozy-stack API |
| **mcp-twake-chat** (this project) | Twake Chat | Matrix |

## What it brings

- **Catch up**: "What did I miss on the chat since yesterday? Who mentioned me this week?"
- **Summarise**: "Summarise the project room for the last seven days."
- **Find**: "What did Alice say about the contract?", "Find the messages about the Atlas budget since September", even in end-to-end encrypted rooms that the homeserver cannot search; "Who is Bob Martin, and do we have a direct conversation?"
- **Prepare answers safely**: "Draft a reply to Alice": the draft lands in your private *Drafts* room, never in the conversation.
- **Encrypted rooms**: the server is a real Matrix device of your account, verified by cross-signing, and restores your key backup, so encrypted history is readable as in a new Twake Chat session.
- **Sovereignty**: the server runs next to your assistant and talks directly to your homeserver.

## Features

### 23 MCP tools

| Category | Tools |
|---|---|
| Account | `whoami` (account, device, encryption status) |
| Rooms | `list_rooms` (filters: kind, unread, name), `get_room_info`, `list_room_members` |
| Messages | `get_messages` (dates, pagination, edits applied, attachments described), `get_thread`, `get_unread`, `get_mentions` |
| Search | `search_messages` (full text, encrypted rooms included; filters: room, sender, dates) |
| Invitations | `list_invitations` |
| Attachments | `download_attachment` (decrypts encrypted files) |
| People | `search_users` (company directory), `get_user_profile` |
| Drafts | `create_draft` (private drafts room only) |
| Write ⚠️ | `send_message` (Markdown, replies, threads, mentions), `react`, `edit_message`, `send_file` (encrypted in encrypted rooms) |
| Rooms ⚠️ | `create_room` (private, encrypted by default, or a direct message), `invite_user`, `join_room` (accept an invitation or join a public room) |
| Destructive ⚠️ | `redact_message` (own messages only), `leave_room` |

⚠️ = acts in your name, visible to other people. Read tools carry `readOnlyHint`; `create_draft` is closed-world (`openWorldHint: false`); write tools carry `openWorldHint`, and `redact_message` and `leave_room` `destructiveHint`, so clients can ask for confirmation.

### Highlights

- **End-to-end encryption**: Rust crypto (WASM) with a persistent store (IndexedDB emulated on SQLite, encrypted with a 32-byte key kept in a `0600` file). On first start the server unlocks your secret storage with your recovery key, imports the cross-signing keys, signs its own device and restores the server key backup; later starts use the local store only.
- **Recovery key**: read from the Twake ToM vault, where Twake Chat stores it (`MATRIX_E2EE_RECOVERY=tom`), or from a file (`key`), or not at all (`off`: only messages received after the first start are readable).
- **One device, one process**: the crypto store is locked by the running process. To share one device between several assistants, run the server once with the **HTTP transport** and point every client to it.
- **Unread messages computed like a client**: from your read receipt and read marker, because servers often return no notification count when push rules mute rooms.
- **Mentions in encrypted rooms**: found client-side (`m.mentions`, or your name in the text), which server-side notifications cannot see.
- **Rooms by name**: every tool accepts a room id, an alias, a DM partner id or a name, case and accents ignored; ambiguous names return the candidates.
- **No password, no OAuth flow inside**: short-lived access tokens come from an external broker you control.

### Search in encrypted rooms

The homeserver never sees the text of end-to-end encrypted messages, so it cannot search them. Like Element's desktop search, the server keeps a **local full-text index** (SQLite FTS5, built into Node) of the messages it can decrypt: new messages as they arrive, messages read through the tools, and a background backfill of the history (`MATRIX_SEARCH_BACKFILL_DAYS`, one year by default). After a restart it catches up on the messages received in the meantime. `search_messages` combines this index for encrypted rooms with the homeserver search for unencrypted rooms, checks that local hits were not deleted since they were indexed, and reports how complete the index is. The index holds message text in clear: it is stored next to the crypto store with `0600` permissions (see [SECURITY.md](SECURITY.md)), and `MATRIX_SEARCH_INDEX=off` disables it.

## Requirements

- **Node.js** >= 22.13 (built-in `node:sqlite`)
- A **Matrix account** on Twake Chat or any homeserver; key backup and secret storage set up for encrypted history
- An **MCP client**

## Installation

```bash
git clone https://github.com/linagora/mcp-twake-chat.git
cd mcp-twake-chat
npm install
npm run build          # then: node build/index.js
```

## Configuration

### Authentication

The server never logs in by itself: it needs a Matrix access token **and the device id it belongs to** (the encryption store is bound to that device).

| Method | Variables |
|---|---|
| **Token command** (recommended) | `MATRIX_USER_ID`, `MATRIX_TOKEN_COMMAND` |
| **Static token** (development) | `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`, `MATRIX_DEVICE_ID` |

`MATRIX_TOKEN_COMMAND` prints `{"access_token": "...", "expires_at": <epoch seconds>, "device_id": "...", "user_id": "..."}` and is run again shortly before expiry. Your broker owns the login and the refresh-token rotation. With Synapse's SSO, a broker typically:

1. sends the user once to `/_matrix/client/v3/login/sso/redirect/<idp>?redirectUrl=…`;
2. exchanges the returned `loginToken` with `POST /_matrix/client/v3/login` (`type: m.login.token`, `refresh_token: true`, a clear `initial_device_display_name`);
3. refreshes with `POST /_matrix/client/v3/refresh` under a lock and prints the JSON above.

`MATRIX_CREDENTIALS_FILE` points to a file of `KEY=VALUE` lines (`MATRIX_ACCESS_TOKEN=…`, `MATRIX_DEVICE_ID=…`) to keep secrets out of the client configuration.

### Other options

| Variable | Description | Default |
|---|---|---|
| `MATRIX_HOMESERVER_URL` | Client-Server API URL | discovered from `https://<server>/.well-known/matrix/client` |
| `TOM_URL` | Twake ToM server (directory, profiles, recovery vault) | discovered (`t.server`, else `m.identity_server`) |
| `MATRIX_E2EE_RECOVERY` | `tom`, `key` (with `MATRIX_RECOVERY_KEY_FILE`) or `off` | `tom` |
| `MATRIX_STORE_DIR` | Private directory of the encrypted crypto store | `~/.local/share/mcp-twake-chat` |
| `MATRIX_STORE_KEY_FILE` | Key encrypting the store (created on first start, `0600`) | `<store dir>/store.key` |
| `MATRIX_DRAFTS_ROOM_NAME` | Name of the private drafts room | `Drafts` |
| `MATRIX_DOWNLOAD_DIR` | Default directory of `download_attachment` | `~/Downloads/twake-chat` |
| `MATRIX_SEARCH_INDEX` | `off` disables the local search index (encrypted rooms are then not searchable) | `on` |
| `MATRIX_SEARCH_BACKFILL_DAYS` | History indexed in the background, in days (`0` = only new messages) | `365` |
| `MCP_TRANSPORT` | `stdio` or `http` | `stdio` |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | HTTP listen address (keep it on loopback) | `127.0.0.1` / `3995` |
| `MCP_HTTP_TOKEN_FILE` | File holding a bearer token required from HTTP clients | none |
| `USER_TIMEZONE` | IANA time zone for displayed and parsed dates | system |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

Check a configuration with `node build/index.js check`: it connects, prints the account, device, encryption state and room counts, and exits.

## Use it with your assistant

### Hermes Agent (shared HTTP daemon)

Run the server once (for example as a systemd user service with `MCP_TRANSPORT=http` and `MCP_HTTP_TOKEN_FILE`), put the token in Hermes' `.env` as `TWAKE_CHAT_MCP_TOKEN`, then:

```yaml
mcp_servers:
  twake_chat:
    url: http://127.0.0.1:3995/mcp
    headers:
      Authorization: "Bearer ${TWAKE_CHAT_MCP_TOKEN}"
    timeout: 120
    tools:
      exclude: [send_message, react, edit_message, redact_message, send_file, join_room, leave_room, create_room, invite_user]   # drafts only
```

### Claude Code / Claude Desktop (stdio)

```bash
claude mcp add twake-chat --scope user \
  -e MATRIX_USER_ID=@jane:example.com \
  -e "MATRIX_TOKEN_COMMAND=/usr/local/bin/my-token-broker chat-token --json" \
  -- node /path/to/mcp-twake-chat/build/index.js
```

Do not configure the same device in two clients at once in stdio mode: the second one is refused by the store lock. Use the HTTP daemon instead.

## Recommended safe configuration

- For an assistant that acts on its own, keep it to **drafts only**: exclude `send_message`, `react`, `edit_message`, `redact_message`, `send_file`, `join_room`, `leave_room`, `create_room` and `invite_user` in your MCP client (example above) and let the user send from Twake Chat. Otherwise, ask the assistant to show the exact message and room and wait for your OK.
- Chat messages are written by other people, possibly from other servers through federation: treat them as untrusted input (prompt injection). The tool descriptions say so to the model.
- The access token gives access to your whole history once the recovery key is fetched from the ToM vault: protect the broker's files (`0600`), never log tokens, and revoke the device from Twake Chat's session list if in doubt.
- Keep the HTTP transport on loopback with a bearer token.

See [SECURITY.md](SECURITY.md).

## Usage examples

- "What's unread on the chat? Summarise by room."
- "Who mentioned me since Friday?"
- "Read the last 50 messages of the Atlas project room and list the decisions."
- "Find Bob Martin in the directory."
- "Draft an answer to Alice proposing Tuesday at 10."
- "Download the PDF Bob posted in the Atlas room and summarise it."
- "Search the chat for what was said about the Atlas budget since September."
- "Do I have pending invitations?"

## Troubleshooting

| Symptom | Fix |
|---|---|
| `already used by process N` | Another server holds this device: stop it, or connect to it over HTTP. |
| `token command JSON has no device_id` | The broker must print the device id that owns the token. |
| `[encrypted message: no key on this device (…)]` | The room key is in no backup you can open (messages older than your key backup, or never backed up). A new Twake Chat session has the same limit. |
| `encryption bootstrap incomplete` in the logs | No recovery key in the ToM vault, or it does not unlock the secret storage: use `MATRIX_E2EE_RECOVERY=key`. |
| `cannot discover the homeserver` | Set `MATRIX_HOMESERVER_URL`. |
| `search_messages` says the index is still indexing | The background backfill of the history is running (see `search index ready` in the logs); recent messages are already searchable. |
| An old encrypted message is not found | It could not be decrypted when indexed (no key in your backup), or it is older than `MATRIX_SEARCH_BACKFILL_DAYS`. |

## Development

```bash
npm install
npm run build
npm test          # Vitest, no real server needed
node build/index.js check
node scripts/smoke.mjs   # live read-only tour of the tools against your account (counts only)
LIVE_ROOM='!room:server' node scripts/live-write.mjs    # write tools, only in a private room where you are alone
LIVE_ROOM='!room:server' node scripts/live-search.mjs   # search, invitations, create and leave a throwaway room
```

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

Copyright © 2026 [LINAGORA](https://linagora.com)
