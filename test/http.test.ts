import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { TokenAuth, hashToken } from '../src/auth.js';
import { MAX_REQUEST_BYTES, routeAccounts, startHttp } from '../src/http.js';
import { decodeWords } from '../src/gmail/mime.js';
import { fixtureAccounts } from './fake-gmail.js';

async function fixture(t: TestContext) {
  const fakes = fixtureAccounts();
  const token = randomBytes(32).toString('hex');
  const auth = TokenAuth.parse({ version: 1, tokens: [{ name: 'agent-a', sha256: hashToken(token) }] });
  const http = await startHttp({ accounts: fakes.accounts, auth, host: '127.0.0.1', port: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [] });
  const endpoint = `http://127.0.0.1:${http.port}`;
  const clients: Client[] = [];
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  t.after(async () => {
    console.error = original;
    await Promise.all(clients.map(client => client.close()));
    await http.close();
  });
  const connect = async (path = '/mcp', credential = token) => {
    const client = new Client({ name: 'http-fixture', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + path), {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: result.structuredContent as Record<string, unknown> | undefined, text: JSON.stringify(result.content) };
  };
  return { ...fakes, endpoint, token, connect, call, logs };
}

const toolSchema = z.object({ inputSchema: z.object({ properties: z.record(z.string(), z.object({ enum: z.array(z.string()).optional() }).passthrough()), required: z.array(z.string()).optional() }) });

test('routes /mcp to all accounts and /mcp/<name> to one', async t => {
  const { connect, call } = await fixture(t);
  const all = await connect('/mcp');
  const tools = (await all.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['gmail_create_draft', 'gmail_get_thread', 'gmail_list_labels', 'gmail_search', 'list_accounts']);
  for (const tool of tools) assert.ok(!/send/i.test(tool.name));
  const getThread = toolSchema.parse(tools.find(tool => tool.name === 'gmail_get_thread'));
  assert.deepEqual(getThread.inputSchema.properties.account?.enum, ['personal', 'work']);
  assert.ok(getThread.inputSchema.required?.includes('account'));
  assert.match(tools.find(tool => tool.name === 'gmail_get_thread')?.description ?? '', /untrusted/);
  assert.deepEqual((await call(all, 'list_accounts', {})).data, { accounts: [{ name: 'personal', email: 'me@example.com' }, { name: 'work', email: 'me@corp.example' }] });
  assert.equal((await call(all, 'gmail_list_labels', {})).result.isError, true);

  const work = await connect('/mcp/work');
  const workTools = (await work.listTools()).tools;
  const workThread = toolSchema.parse(workTools.find(tool => tool.name === 'gmail_get_thread'));
  assert.deepEqual(workThread.inputSchema.properties.account?.enum, ['work']);
  assert.ok(!workThread.inputSchema.required?.includes('account'));
  assert.deepEqual((await call(work, 'list_accounts', {})).data, { accounts: [{ name: 'work', email: 'me@corp.example' }] });
  const labels = await call(work, 'gmail_list_labels', {});
  assert.equal(labels.data?.account, 'work');
  // The work endpoint cannot reach personal mail, even when asked by name.
  assert.equal((await call(work, 'gmail_get_thread', { account: 'personal', threadId: 't1' })).result.isError, true);
  assert.equal((await call(work, 'gmail_search', { account: 'all', query: 'x' })).data?.threads instanceof Array, true);
  const allFromWork = await call(work, 'gmail_search', { account: 'all', query: 'x' });
  assert.deepEqual((allFromWork.data?.threads as { account: string }[]).map(thread => thread.account), ['work']);
});

test('routeAccounts matches only exact paths', () => {
  const { accounts } = fixtureAccounts();
  assert.equal(routeAccounts('/mcp', accounts).accounts?.length, 2);
  assert.deepEqual(routeAccounts('/mcp/work', accounts).accounts?.map(account => account.name), ['work']);
  assert.deepEqual(routeAccounts('/mcp/nope', accounts), { match: true });
  for (const url of ['/mcp/', '/mcp/work/', '/mcp?x=1', '/mcp/work?x', '/mcp/../mcp', '/mcp/work/extra', '/mcpx', '/', undefined]) {
    assert.equal(routeAccounts(url, accounts).match, false, String(url));
  }
});

test('gmail_search merges accounts newest first and pages a single account', async t => {
  const { connect, call, personal, work } = await fixture(t);
  const client = await connect();
  const all = await call(client, 'gmail_search', { account: 'all', query: 'in:inbox', maxResults: 10 });
  const threads = z.array(z.object({ account: z.string(), threadId: z.string(), subject: z.string(), firstFrom: z.string(), lastFrom: z.string(), date: z.string(), messageCount: z.number(), unread: z.boolean(), link: z.string(), snippet: z.string() }))
    .parse(all.data?.threads);
  assert.deepEqual(threads.map(thread => thread.threadId), ['w1', 't1', 't2']);
  const t1 = threads[1]!;
  assert.deepEqual([t1.subject, t1.firstFrom, t1.lastFrom, t1.messageCount, t1.unread], ['Lunch?', 'Alice <alice@example.com>', 'Me <me@example.com>', 2, true]);
  assert.equal(t1.link, 'https://mail.google.com/mail/?authuser=me%40example.com#all/t1');
  assert.ok(personal.calls.includes('thread:t1:metadata') && work.calls.includes('thread:w1:metadata'));

  const page = await call(client, 'gmail_search', { account: 'personal', query: 'x', maxResults: 1 });
  assert.equal(page.data?.nextPageToken, '1');
  const next = await call(client, 'gmail_search', { account: 'personal', query: 'x', maxResults: 1, pageToken: '1' });
  assert.deepEqual((next.data?.threads as { threadId: string }[]).map(thread => thread.threadId), ['t2']);
  const rejected = await call(client, 'gmail_search', { account: 'all', query: 'x', pageToken: '1' });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.text, /single account/);
});

test('gmail_get_thread returns plain text, strips quotes and caps messages', async t => {
  const { connect, call } = await fixture(t);
  const client = await connect('/mcp/personal');
  const full = await call(client, 'gmail_get_thread', { threadId: 't1' });
  const messages = z.array(z.object({ id: z.string(), from: z.string(), subject: z.string(), body: z.string(), quoteStripped: z.boolean() })).parse(full.data?.messages);
  assert.deepEqual(messages.map(m => [m.id, m.body, m.quoteStripped]), [['p1', 'Lunch on Friday?', false], ['p2', 'Yes!', true]]);
  const capped = await call(client, 'gmail_get_thread', { threadId: 't1', maxMessages: 1, maxCharsPerMessage: 100 });
  assert.equal(capped.data?.omittedEarlierMessages, 1);
  assert.deepEqual((capped.data?.messages as { id: string }[]).map(m => m.id), ['p2']);
  assert.equal((await call(client, 'gmail_get_thread', { threadId: '../x' })).result.isError, true);
});

test('gmail_create_draft builds replies in-thread and never sends', async t => {
  const { connect, call, personal, logs } = await fixture(t);
  const client = await connect();
  const reply = await call(client, 'gmail_create_draft', { account: 'personal', body: 'See you then', replyToMessageId: 'p2' });
  assert.ok(!reply.result.isError, reply.text);
  assert.deepEqual(reply.data, {
    account: 'personal', draftId: 'r-1', messageId: 'm-1', threadId: 't1',
    to: ['Smith, Alice <alice.reply@example.com>'], subject: 'Re: Lunch?',
    link: 'https://mail.google.com/mail/?authuser=me%40example.com#drafts?compose=m-1', sent: false,
  });
  const draft = personal.drafts[0]!;
  assert.equal(draft.threadId, 't1');
  const raw = Buffer.from(draft.raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: "Smith, Alice" <alice\.reply@example\.com>\r$/m);
  assert.match(raw, /^Subject: Re: Lunch\?\r$/m);
  assert.match(raw, /^In-Reply-To: <p2@mail\.example\.com>\r$/m);
  assert.match(raw.replace(/\r\n /g, ' '), /^References: <p1@mail\.example\.com> <p2@mail\.example\.com>\r$/m);

  const fresh = await call(client, 'gmail_create_draft', { account: 'personal', to: ['Zoë <zoe@example.com>'], cc: ['c@example.com'], subject: 'Grüße', body: 'Hallo' });
  assert.ok(!fresh.result.isError, fresh.text);
  const freshRaw = Buffer.from(personal.drafts[1]!.raw, 'base64url').toString('utf8');
  assert.equal(personal.drafts[1]!.threadId, undefined);
  assert.equal(decodeWords(/^Subject: (.*)\r$/m.exec(freshRaw)?.[1] ?? ''), 'Grüße');

  const injected = await call(client, 'gmail_create_draft', { account: 'personal', to: ['a@example.com'], subject: 'Hi\r\nBcc: evil@example.com', body: 'x' });
  assert.equal(injected.result.isError, true);
  assert.equal((await call(client, 'gmail_create_draft', { account: 'personal', to: ['not an address'], body: 'x' })).result.isError, true);
  assert.equal((await call(client, 'gmail_create_draft', { account: 'personal', body: 'no recipients' })).result.isError, true);
  assert.equal(personal.drafts.length, 2);
  assert.ok(personal.calls.every(name => !/send/.test(name)));

  // Logs: tool, account and client only; never content or addresses.
  const toolLogs = logs.filter(line => line.includes('"tool_call"')).map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(toolLogs[0], { event: 'tool_call', tool: 'gmail_create_draft', account: 'personal', client: 'agent-a' });
  assert.ok(logs.every(line => !/See you then|alice|Grüße|evil/.test(line)), logs.join('\n'));
});

test('a revoked refresh token tells the user how to re-authorise', async t => {
  const { connect, call, work } = await fixture(t);
  work.revoked = true;
  const client = await connect();
  const failed = await call(client, 'gmail_list_labels', { account: 'work' });
  assert.equal(failed.result.isError, true);
  assert.match(failed.text, /pnpm auth:google --account work/);
  assert.match(failed.text, /accounts\.json/);
  // Searching all accounts still returns the healthy ones, plus the error.
  const all = await call(client, 'gmail_search', { account: 'all', query: 'x' });
  assert.deepEqual((all.data?.threads as { account: string }[]).map(thread => thread.account), ['personal', 'personal']);
  assert.match(JSON.stringify(all.data?.errors), /auth:google --account work/);
});

test('HTTP rejects missing, wrong, malformed and duplicate credentials before MCP runs', async t => {
  const { endpoint, token, personal, work } = await fixture(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gmail_create_draft', arguments: { account: 'personal', to: ['a@example.com'], body: 'x' } } });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const path of ['/mcp', '/mcp/personal', '/mcp/unknown']) {
    for (const credential of ['', `Bearer ${randomBytes(32).toString('hex')}`, `Basic ${token}`, 'Bearer short', `Bearer ${token}, Bearer ${token}`]) {
      const response = await fetch(endpoint + path, { method: 'POST', body, headers: { ...headers, ...(credential ? { authorization: credential } : {}) } });
      assert.equal(response.status, 401, `${path} ${credential.slice(0, 6)}`);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="workspace-mcp"');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  const duplicateStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(endpoint + '/mcp', { method: 'POST', headers: ['Host', new URL(endpoint).host, 'Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`] }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject); req.end(body);
  });
  assert.equal(duplicateStatus, 401);
  assert.equal((await fetch(endpoint + '/mcp?access_token=' + token, { method: 'POST', body })).status, 404);
  assert.equal(personal.drafts.length + work.drafts.length, 0);
  assert.equal(personal.calls.length + work.calls.length, 0);
});

test('authenticated HTTP enforces Host/Origin, unknown accounts, methods and size', async t => {
  const { endpoint, token } = await fixture(t);
  const authorization = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(endpoint + '/health')).status, 200);
  assert.equal((await fetch(endpoint + '/mcp', { headers: authorization })).status, 405);
  assert.equal((await fetch(endpoint + '/mcp/unknown', { method: 'POST', headers: authorization, body: '{}' })).status, 404);
  assert.equal((await fetch(endpoint + '/missing')).status, 404);
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(endpoint + '/health', { headers: { host: 'evil.example' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(endpoint + '/health', { headers: { origin: 'https://evil.example' } })).status, 403);
  const headers = { ...authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(endpoint + '/mcp', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(endpoint + '/mcp', { method: 'POST', headers, body: ' '.repeat(MAX_REQUEST_BYTES + 1) })).status, 413);
});
