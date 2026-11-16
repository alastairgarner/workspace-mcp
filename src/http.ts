import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { finished } from 'node:stream/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TokenAuth } from './auth.js';
import { errorMessage } from './errors.js';
import type { Account } from './gmail/service.js';
import { createServer } from './server.js';

export const MAX_REQUEST_BYTES = 1024 * 1024;
const MCP_PATH = /^\/mcp(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?$/;

type HttpOptions = {
  accounts: readonly Account[];
  auth: TokenAuth;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxHttpRequests?: number;
  maxHttpConnections?: number;
};

/** `/mcp` serves every account; `/mcp/<name>` serves only that account; anything else is undefined. */
export function routeAccounts(url: string | undefined, accounts: readonly Account[]): { match: boolean; accounts?: readonly Account[] } {
  const match = MCP_PATH.exec(url ?? '');
  if (!match) return { match: false };
  const name = match[1];
  if (name === undefined) return { match: true, accounts };
  const account = accounts.find(candidate => candidate.name === name);
  return account ? { match: true, accounts: [account] } : { match: true };
}

export async function startHttp({ accounts, auth, host, port, allowedHosts, allowedOrigins, maxHttpRequests = 8, maxHttpConnections = 32 }: HttpOptions) {
  if (!auth) throw new Error('HTTP authentication is required');
  if (!allowedHosts.length) throw new Error('At least one allowed hostname is required');
  if (!accounts.length) throw new Error('At least one Google account is required; run pnpm auth:google first');
  let admitted = 0;
  let accepting = true;
  const active = new Set<Promise<void>>();
  const send = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ message }));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!accepting) { send(res, 503, 'Shutting down'); return; }
    // Hostnames are port-agnostic, never inferred from untrusted proxy headers.
    let authority: URL;
    try { authority = new URL(`http://${req.headers.host ?? ''}`); }
    catch { send(res, 403, 'Invalid Host'); return; }
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash || !allowedHosts.includes(authority.hostname)) {
      send(res, 403, 'Host not allowed'); return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) { send(res, 403, 'Origin not allowed'); return; }
    if (req.url === '/health' && req.method === 'GET') { send(res, 200, 'ok'); return; }
    const route = routeAccounts(req.url, accounts);
    if (!route.match) { send(res, 404, 'Not found'); return; }
    const principal = auth.authenticate(req.headersDistinct.authorization);
    if (!principal) {
      res.setHeader('www-authenticate', 'Bearer realm="workspace-mcp"');
      send(res, 401, 'Unauthorized'); return;
    }
    // Only after authentication, so unauthenticated callers can't enumerate account names.
    if (!route.accounts) { send(res, 404, 'Unknown account'); return; }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      send(res, 405, 'Stateless MCP accepts POST only'); return;
    }
    if (admitted >= maxHttpRequests) {
      res.setHeader('retry-after', '1');
      res.setHeader('connection', 'close');
      send(res, 503, 'Server busy; retry later'); return;
    }
    // One SDK server/transport per request prevents cross-client request-ID collisions.
    console.error(JSON.stringify({ event: 'mcp_request_authenticated', client: principal.name, path: req.url }));
    const server = createServer({ accounts: route.accounts, client: principal.name });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MAX_REQUEST_BYTES });
    admitted++;
    try {
      await server.connect(transport);
      res.setHeader('cache-control', 'no-store');
      await transport.handleRequest(req, res);
      if (!res.writableFinished && !res.destroyed) await finished(res, { cleanup: true });
    } finally {
      try { await server.close(); }
      finally { admitted--; }
    }
  };
  const http = createHttpServer({ requestTimeout: 60_000, headersTimeout: 10_000 }, (req, res) => {
    const task = handle(req, res).catch(error => {
      console.error(JSON.stringify({ event: 'http_request_failed', error: errorMessage(error) }));
      if (!res.headersSent) send(res, 500, 'Internal server error');
      else if (!res.writableEnded) res.end();
    }).finally(() => { active.delete(task); });
    active.add(task);
  });
  http.maxConnections = maxHttpConnections;
  http.maxRequestsPerSocket = 100;
  http.setTimeout(60_000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    close(): Promise<void> {
      accepting = false;
      closing ??= (async () => {
        await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        await Promise.all(active);
      })();
      return closing;
    },
  };
}
