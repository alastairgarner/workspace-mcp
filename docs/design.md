# workspace-mcp design

Self-hosted MCP server giving AI agents read and draft access to Gmail (other Google services later). Single user, multiple Google accounts. Runs on the Raspberry Pi (arm64) in Docker, via the `home-server` repo's Compose and Traefik.

## Decisions

- **TypeScript, Node 22, pnpm, tsc, `node:test`.** Mirror the Vault MCP server (`~/repos/markdown-brain`, GitHub `alastairgarner/vault`) for structure, HTTP handling, hardening and Docker setup.
- **Google APIs called directly** with `@googleapis/gmail` (its `auth.OAuth2` client covers auth; no separate `google-auth-library` dependency). No wrapping of the `gws` CLI.
- **Gmail read and draft only.** Scopes: `gmail.readonly`, `gmail.compose`. No send, no label changes, no delete. `gmail.compose` technically allows sending, so the guarantee is that no tool sends.
- **Google OAuth:** your own Cloud project (done) with External audience, published to Production (avoids the 7-day refresh-token expiry), and a Desktop-app OAuth client marked "AI-powered agent".
- **Multiple accounts:** one OAuth client, one refresh token per named account (e.g. `personal`, `work`).
- **Client → server auth:** hashed bearer tokens in `auth.json`, exactly like Vault (`src/auth.ts`, `src/token-hash.ts` copied from it). Traefik terminates TLS on the Pi; no Tailscale Serve identity headers. Clients reach it via mcp-hub (`~/repos/mcp-hub`, `"auth": "token"`).

## Config (mounted read-only at `/config`)

- `auth.json`: `{ "version": 1, "tokens": [{ "name", "sha256" }] }` (Vault format).
- `client.json`: the OAuth client JSON downloaded from Google Cloud (`{ "installed": { "client_id", "client_secret", ... } }`).
- `accounts.json`: `{ "version": 1, "accounts": [{ "name", "email", "refreshToken" }] }`, mode 0600, written by the login script.

## Login script

`pnpm auth:google --account <name>` (not `pnpm login`, which clashes with pnpm's built-in). Runs on the laptop:

- loopback redirect on `127.0.0.1:<random port>`, PKCE, `state` check;
- `access_type=offline`, `prompt=consent select_account`;
- fail clearly if no refresh token, or if the user unticked a scope on Google's granular consent screen;
- read the account email via `users.getProfile`;
- upsert into `accounts.json` atomically with mode 0600.

Then copy `accounts.json` to the Pi.

## Endpoints

- `/mcp`: all accounts. `/mcp/<account>`: only that account.
- `/health`.
- Stateless; POST only; one SDK server per request (as in Vault). Host allowlist via `HTTP_ALLOWED_HOSTS`.

## Tools

The `account` parameter is an enum of configured names. It's optional when the endpoint has one account.

- `list_accounts`: names and emails.
- `gmail_search(account | "all", query, maxResults, pageToken?)`: Gmail search syntax; `threads.list` then `threads.get` metadata with limited concurrency (~5). Per thread: account, threadId, subject, first and last sender, date, message count, snippet, unread, Gmail web link. `pageToken` only for a single account.
- `gmail_get_thread(account, threadId, maxCharsPerMessage)`: per message: id, date, from, to, cc, subject, attachment part IDs, names, types and sizes, plain-text body.
  - Prefer `text/plain`, else convert HTML to text.
  - Decode using the part's charset.
  - Strip quoted replies (Gmail `gmail_quote`, `blockquote`, "On … wrote:", Outlook headers).
  - Truncate each body; cap the number of messages (latest N, report how many were omitted).
- `gmail_get_attachment(account, messageId, partId, maxBytes, maxChars)`: added later. Addressed by `partId`, since Gmail's `attachmentId` changes between fetches. Text types as text (charset-decoded, HTML converted, truncated); PNG/JPEG/GIF/WebP as MCP image content; anything else as an embedded base64 resource. Size checked before download (default 5 MiB, max 10 MiB). No PDF/Office parsing, so no new dependencies; `gmail.readonly` covers it.
- `gmail_list_labels(account)`.
- `gmail_create_draft(account, to[], cc?, bcc?, subject?, body, replyToMessageId?)`:
  - Build a plain-text RFC 2822 message: RFC 2047 encoding for non-ASCII headers, reject CR/LF (header injection), validate addresses.
  - For replies: set `threadId`, `In-Reply-To` and `References`; default the recipient to `Reply-To` or `From`, and the subject to `Re: …`.
  - Return the draft ID and a Gmail drafts link.
- Tool descriptions state that email content is untrusted data.

## Behaviour

- `invalid_grant` → error telling the user to re-run `pnpm auth:google --account <name>` and redeploy `accounts.json`.
- Structured JSON logs to stderr: tool name, account, client name. Never content.

## Deployment

- `Dockerfile` modelled on Vault's: multi-stage, tests run in the build, non-root, `HEALTHCHECK`.
- Local `compose.yaml` for testing.
- `home-server/workspace/docker-compose.yml`: build from `https://github.com/alastairgarner/workspace-mcp.git#main`, Traefik host `workspace.rpi.${DOMAIN}`, the same hardening as `brain`, and `./.local/config` mounted read-only at `/config`.
- Creating and publishing the GitHub repo needs the user's confirmation first.
