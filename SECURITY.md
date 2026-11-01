# Security Policy

mcp-twake-chat gives an AI assistant access to private conversations in [Twake.ai](https://twake.ai), including end-to-end encrypted ones. We take its security seriously and thank everyone who reports issues responsibly.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x | ✅ |
| 0.1.x | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately, by one of these channels:

1. GitHub private vulnerability reporting: [Report a vulnerability](https://github.com/linagora/mcp-twake-chat/security/advisories/new);
2. email to **dpo@linagora.com**.

Please include the affected version or commit, a description of the issue and its impact, steps to reproduce, and any suggested fix. We will acknowledge your report within **5 business days** and agree with you on a disclosure date once a fix is available.

## Security model and hardening

- **A real device of your account**: the server is a Matrix device, signed with your cross-signing keys. It can read everything your account can read, encrypted rooms included. Give it a clear name and revoke it from your client's session list when you stop using it.
- **Recovery key**: with `MATRIX_E2EE_RECOVERY=tom` the recovery key is fetched from the ToM vault with the access token; anyone holding a valid token can therefore open your key backup. Protect the token broker's files (`0600`) and never log tokens or keys. The server keeps the key in memory only during the first start, then relies on its local store.
- **Local store**: the crypto store (`MATRIX_STORE_DIR`, `0700`) is encrypted with the key in `MATRIX_STORE_KEY_FILE` (`0600`). Anyone with both can impersonate the device: keep them on an account only you control, and back them up only to encrypted storage.
- **Writing in your name**: `send_message`, `react`, `edit_message`, `send_file` and `redact_message` post as you, visible to the room members; `redact_message` cannot be undone. Exclude them in your MCP client for an unattended assistant, or require a confirmation. `edit_message` and `redact_message` refuse messages you did not send. `create_draft` posts only in a private room whose only member is you, and refuses if that room gained members.
- **Downloads**: `download_attachment` writes into `MATRIX_DOWNLOAD_DIR` (or an absolute `save_dir`), sanitises the file name and never overwrites an existing file. Downloaded files are third-party content.
- **HTTP transport**: listens on loopback by default, checks the `Host` header (DNS rebinding) and requires a bearer token when `MCP_HTTP_TOKEN_FILE` is set.
- **Prompt injection**: messages, room names and topics are written by third parties, possibly from federated servers. MCP clients should treat them as data, never as instructions.
