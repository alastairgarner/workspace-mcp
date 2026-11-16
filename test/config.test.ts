import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts, loadAccountsOrEmpty, loadClient, parseAccounts, upsertAccount, writeJsonAtomic } from '../src/config.js';
import { mapGoogleError, SCOPES } from '../src/gmail/client.js';
import { authUrl, missingScopes, pkce } from '../src/oauth.js';
import { createHash } from 'node:crypto';

const SECRET = '1//refresh-token-secret';

test('accounts.json validation never echoes secrets', () => {
  assert.throws(() => parseAccounts({ version: 1, accounts: [{ name: 'bad name', email: 'a@example.com', refreshToken: SECRET }] }), error => {
    assert.ok(error instanceof Error && !error.message.includes(SECRET));
    return true;
  });
  assert.throws(() => parseAccounts({ version: 1, accounts: [{ name: 'all', email: 'a@example.com', refreshToken: SECRET }] }), /reserved/);
  assert.throws(() => parseAccounts({ version: 1, accounts: [
    { name: 'a', email: 'a@example.com', refreshToken: SECRET }, { name: 'a', email: 'b@example.com', refreshToken: SECRET },
  ] }), /Duplicate/);
  assert.throws(() => parseAccounts({ version: 1, accounts: [{ name: 'a', email: 'not-email', refreshToken: SECRET, extra: true }] }), /accounts\.json/);
});

test('upsert replaces by name and atomic write is 0600', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'accounts.json');
  let accounts = await loadAccountsOrEmpty(file);
  assert.deepEqual(accounts, { version: 1, accounts: [] });
  accounts = upsertAccount(accounts, { name: 'work', email: 'w@example.com', refreshToken: 'one' });
  accounts = upsertAccount(accounts, { name: 'personal', email: 'p@example.com', refreshToken: 'two' });
  accounts = upsertAccount(accounts, { name: 'work', email: 'w2@example.com', refreshToken: 'three' });
  await writeJsonAtomic(file, accounts);
  const loaded = await loadAccounts(file);
  assert.deepEqual(loaded.accounts.map(a => [a.name, a.email, a.refreshToken]), [['personal', 'p@example.com', 'two'], ['work', 'w2@example.com', 'three']]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['accounts.json']);
  await fs.symlink(file, path.join(dir, 'link.json'));
  await assert.rejects(loadAccounts(path.join(dir, 'link.json')), /ELOOP/);
});

test('client.json requires a Desktop "installed" client', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-client-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'client.json');
  await fs.writeFile(file, JSON.stringify({ installed: { client_id: 'id.apps.googleusercontent.com', client_secret: 'GOCSPX-secret', redirect_uris: ['http://localhost'] } }));
  assert.deepEqual(await loadClient(file), { clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  await fs.writeFile(file, JSON.stringify({ web: { client_id: 'x', client_secret: 'GOCSPX-secret' } }));
  await assert.rejects(loadClient(file), error => error instanceof Error && /installed/.test(error.message) && !error.message.includes('GOCSPX'));
});

test('OAuth URL uses PKCE S256, offline access, consent and both scopes', () => {
  const { verifier, challenge } = pkce();
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  const url = new URL(authUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1234', state: 'st', challenge }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(params, {
    client_id: 'cid', redirect_uri: 'http://127.0.0.1:1234', response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent select_account', state: 'st', code_challenge: challenge, code_challenge_method: 'S256',
  });
  assert.deepEqual(missingScopes(SCOPES.join(' ')), []);
  assert.deepEqual(missingScopes(`${SCOPES[0]} openid`), [SCOPES[1]]);
  assert.deepEqual(missingScopes(undefined), [...SCOPES]);
});

test('Google errors map invalid_grant to re-auth instructions', () => {
  const grant = mapGoogleError(Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }), 'work');
  assert.match(grant.message, /pnpm auth:google --account work/);
  const other = mapGoogleError(Object.assign(new Error('Requested entity was not found.'), { status: 404 }), 'work');
  assert.equal(other.message, 'Gmail API error for account "work" (404): Requested entity was not found.');
});
