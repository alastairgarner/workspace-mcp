# workspace-mcp

Self-hosted MCP server giving AI agents **read and draft** access to Gmail, for one user with several Google accounts. Runs on the Raspberry Pi in Docker behind Traefik (via `home-server`). Decisions: [docs/design.md](docs/design.md).

No tool sends, deletes, archives or relabels mail. Drafts appear in Gmail for you to review and send.

## Tools

| Tool | What it does |
| --- | --- |
| `list_accounts` | Account names and emails on this endpoint. |
| `gmail_search` | Gmail search syntax over one account or `"all"`; per thread: subject, first/last sender, date, count, snippet, unread, web link. `pageToken` for a single account only. |
| `gmail_get_thread` | Plain-text messages (HTML converted, charset-decoded, quoted replies stripped, bodies truncated, latest `maxMessages` only) plus attachment part IDs, names, types and sizes. |
| `gmail_get_attachment` | One attachment by `messageId` + `partId` (from `gmail_get_thread`). Text types as text, PNG/JPEG/GIF/WebP as images, anything else (PDF, Office, zip) as an embedded base64 file. Refused over `maxBytes` (default 5 MiB, max 10 MiB). No PDF text extraction. |
| `gmail_list_labels` | Label IDs, names and types. |
| `gmail_create_draft` | Plain-text draft. With `replyToMessageId` it joins the thread and defaults `to` and `Re:` subject. Returns the draft ID and a Gmail link. |

`account` is an enum of configured names, optional when the endpoint serves one account.

## Endpoints

- `POST /mcp`: every account. `POST /mcp/<account>`: only that account.
- `GET /health`: unauthenticated liveness.
- Every `/mcp` request needs `Authorization: Bearer <token>` matching a hash in `auth.json`. Host header must be in `HTTP_ALLOWED_HOSTS`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm test          # tsc build + node:test; never calls Google
docker build -t workspace-mcp:local .   # runs the tests inside the build
```

Layout: `src/http-main.ts` (entrypoint, env), `src/http.ts` (auth, routing), `src/server.ts` (tools), `src/gmail/` (`client.ts` Google API adapter, `service.ts` tool logic, `mime.ts` draft building, `body.ts` / `html.ts` / `quotes.ts` body extraction, `attachments.ts`), `src/config.ts`, `src/login.ts` + `src/oauth.ts` (Google login), `src/auth.ts` + `src/token-hash.ts` (bearer tokens, from Vault).

## Setup

Everything private lives in `.local/config/` (Git-ignored), mounted read-only at `/config`:

| File | Contents |
| --- | --- |
| `client.json` | Desktop OAuth client from Google Cloud. |
| `accounts.json` | One refresh token per account (written by `pnpm auth:google`, mode 0600). |
| `auth.json` | SHA-256 hashes of client bearer tokens. |

### 1. Download the OAuth client JSON

Google Cloud console → **APIs & Services → Credentials** → your Desktop OAuth client → **Download JSON**. Then:

If there's no download (Google only shows secrets at creation now), click **Add secret** on the client and write the file by hand: `{ "installed": { "client_id": "…", "client_secret": "…" } }`.


```sh
mkdir -p .local/config && chmod 700 .local/config
mv ~/Downloads/client_secret_*.json .local/config/client.json
chmod 600 .local/config/client.json
```

The Gmail API must be enabled in the project, and the consent screen must be **In production**, or refresh tokens expire after 7 days.

### 2. Sign in to each Google account

On the laptop (needs a browser), once per account:

```sh
pnpm auth:google --account personal
pnpm auth:google --account work
```

Each run prints a Google sign-in URL (and opens it if there's a local browser). The browser can be on another machine: when Google redirects to `http://127.0.0.1:…` and the page fails to load, copy that address and paste it at the script's prompt. Google warns the app is unverified; click **Advanced → Go to … (unsafe)**, which is fine for your own client. Pick the right account and **tick every permission**. The script fails if Google returns no refresh token or a permission was unticked. It reads the account's email and upserts it into `.local/config/accounts.json`. It never prints tokens. Re-run it for an account whose access has expired or been revoked.

### 3. Create and hash the client token

The token is what mcp-hub sends; the server only stores its hash.

```sh
pnpm build
cp config/auth.example.json .local/config/auth.json && chmod 600 .local/config/auth.json
openssl rand -hex 32        # copy it; it's the token for `mcp auth workspace` in step 5
unset TOKEN; read -rsp 'Token: ' TOKEN; printf '\n'
printf '%s' "$TOKEN" | node dist/src/token-hash.js
unset TOKEN
```

Put the printed hash in `.local/config/auth.json` in place of the placeholder (the name is used in logs, e.g. `mcp-hub`). Add one entry per client if you want separate tokens.

Local test, optional: `docker compose up --build`, then MCP on `http://127.0.0.1:8182/mcp`.

### 4. Copy the config to the Pi and deploy

`home-server/workspace/docker-compose.yml` builds from `https://github.com/alastairgarner/workspace-mcp.git#main` (needs the GitHub repo first) and mounts `workspace/.local/config` there.

```sh
PI=alastair@<pi-host>   # the Pi; home-server is checked out at ~/services
ssh "$PI" 'mkdir -p ~/services/workspace/.local/config && chmod 700 ~/services/workspace/.local ~/services/workspace/.local/config'
scp .local/config/{client.json,accounts.json,auth.json} "$PI":services/workspace/.local/config/
ssh "$PI" 'chmod 600 ~/services/workspace/.local/config/*.json && cd ~/services && docker compose up -d --build workspace'
```

The container runs as UID 1000 and must be able to read the files. Config is read once at startup: after changing any of them, run `docker compose restart workspace` on the Pi. After re-running `pnpm auth:google`, copy `accounts.json` again and restart.

### 5. Add it to mcp-hub

In `~/.config/mcp-hub/servers.json`, under `mcpServers`:

```json
"workspace": { "url": "https://workspace.rpi.<DOMAIN>/mcp", "auth": "token" }
```

For a single-account endpoint, add another entry, e.g. `"workspace-work": { "url": "https://workspace.rpi.<DOMAIN>/mcp/work", "auth": "token" }`.

Then run `mcp auth workspace` and paste the token from step 3 at its prompt. Run `mcp install claude` (or `codex`, `pi`) to expose it to harnesses.

## Behaviour notes

- Email content is untrusted. Tool descriptions say so; the server doesn't sanitise instructions out of mail.
- Logs are JSON on stderr: tool, account, client name. Never queries, addresses or content.
- If Google rejects a refresh token (`invalid_grant`), the tool error says to re-run `pnpm auth:google --account <name>` and redeploy `accounts.json`.
- Quote stripping and HTML conversion are heuristics. `quoteStripped` and `bodyFormat` show what happened per message.
- Draft links use `#drafts?compose=<messageId>`; if Gmail doesn't open the draft directly, it's in Drafts.
