// Laptop-only: `pnpm auth:google --account <name> [--config-dir .local/config]`.
// Loopback OAuth with PKCE and state; stores the refresh token in accounts.json (0600). Never prints tokens.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { gmail } from '@googleapis/gmail';
import { accountNameSchema, loadAccountsOrEmpty, loadClient, upsertAccount, writeJsonAtomic } from './config.js';
import { errorMessage } from './errors.js';
import { createOAuthClient } from './gmail/client.js';
import { authUrl, missingScopes, parseCallback, pkce } from './oauth.js';

const TIMEOUT_MS = 5 * 60_000;

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* the URL is printed; opening is best-effort */ });
    child.unref();
  } catch { /* best-effort */ }
}

// Two ways back: the browser hits the loopback listener (same machine), or the user pastes the
// failed redirect URL at the prompt (browser on another machine). Both are checked by parseCallback.
async function waitForCode(state: string) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/') { res.writeHead(404).end(); return; }
    const reply = (status: number, message: string) => res
      .writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(`<!doctype html><meta charset="utf-8"><title>workspace-mcp</title><p>${message}</p>`);
    try {
      const value = parseCallback(url.toString(), state);
      reply(200, 'Signed in. You can close this tab and return to the terminal.');
      resolveCode(value);
    } catch (error) {
      reply(400, 'Sign-in failed. Check the terminal, then close this tab.');
      rejectCode(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  let prompt: ReturnType<typeof createInterface> | undefined;
  const startPrompt = () => {
    if (!process.stdin.isTTY) return;
    prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true, historySize: 0 });
    const ask = () => prompt?.question('Or paste the http://127.0.0.1:… URL from the browser here: ', answer => {
      if (!answer.trim()) { ask(); return; }
      try { resolveCode(parseCallback(answer, state)); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); ask(); }
    });
    ask();
  };
  const timer = setTimeout(() => rejectCode(new Error('Timed out after 5 minutes waiting for Google sign-in')), TIMEOUT_MS);
  return {
    redirectUri: `http://127.0.0.1:${address.port}`,
    code,
    startPrompt,
    close: () => { clearTimeout(timer); prompt?.close(); server.close(); server.closeAllConnections(); },
  };
}

async function main() {
  const { values } = parseArgs({ options: { account: { type: 'string' }, 'config-dir': { type: 'string', default: '.local/config' } }, strict: true });
  const name = accountNameSchema.safeParse(values.account);
  if (!name.success) throw new Error('Usage: pnpm auth:google --account <name> [--config-dir .local/config]. Names are 1–64 letters, numbers, _ or -, and not "all".');
  const configDir = path.resolve(values['config-dir']);
  const accountsFile = path.join(configDir, 'accounts.json');
  const client = await loadClient(path.join(configDir, 'client.json'));
  // Validate the existing file before the browser step, so a broken file fails fast.
  await loadAccountsOrEmpty(accountsFile);

  const state = randomBytes(24).toString('base64url');
  const { verifier, challenge } = pkce();
  const callback = await waitForCode(state);
  let refreshToken: string;
  let email: string;
  try {
    const url = authUrl({ clientId: client.clientId, redirectUri: callback.redirectUri, state, challenge });
    console.error(`Sign in to the Google account for "${name.data}". Open this URL in a browser on any machine:\n\n${url}\n\n`
      + 'On this machine the browser returns here automatically. Elsewhere, the final page fails to load: copy its address and paste it below.\n');
    openBrowser(url);
    callback.startPrompt();
    const code = await callback.code;
    const oauth = createOAuthClient(client, callback.redirectUri);
    const { tokens } = await oauth.getToken({ code, codeVerifier: verifier, redirect_uri: callback.redirectUri });
    const missing = missingScopes(tokens.scope);
    if (missing.length) throw new Error(`Not all permissions were granted (missing: ${missing.join(', ')}). Run the command again and tick every box on Google's consent screen.`);
    if (!tokens.refresh_token) throw new Error('Google returned no refresh token. Remove the app at https://myaccount.google.com/connections and run the command again.');
    refreshToken = tokens.refresh_token;
    oauth.setCredentials(tokens);
    const profile = await gmail({ version: 'v1', auth: oauth, timeout: 20_000 }).users.getProfile({ userId: 'me' });
    if (!profile.data.emailAddress) throw new Error('Could not read the account email address');
    email = profile.data.emailAddress;
  } finally { callback.close(); }
  console.error('Signed in; saving account.');

  // Re-read just before writing, so a concurrent login for another account isn't lost.
  const updated = upsertAccount(await loadAccountsOrEmpty(accountsFile), { name: name.data, email, refreshToken });
  await writeJsonAtomic(accountsFile, updated);
  console.error(`Saved account "${name.data}" (${email}) to ${accountsFile}. Copy it to the Pi to deploy.`);
}

main().catch(error => {
  // gaxios errors can carry request bodies; print only the message.
  console.error(`auth:google failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
