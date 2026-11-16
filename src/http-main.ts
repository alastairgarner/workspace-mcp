import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { TokenAuth } from './auth.js';
import { loadAccounts, loadClient } from './config.js';
import { errorMessage } from './errors.js';
import { googleGmail } from './gmail/client.js';
import { startHttp } from './http.js';

const config = z.object({
  CONFIG_DIR: z.string().min(1).default('/config'),
  HTTP_HOST: z.string().refine(value => isIP(value) !== 0, 'Use an explicit IP address').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1,[::1]'),
  HTTP_ALLOWED_ORIGINS: z.string().default(''),
  MAX_HTTP_REQUESTS: z.coerce.number().int().min(1).max(64).default(8),
  MAX_HTTP_CONNECTIONS: z.coerce.number().int().min(1).max(256).default(32),
}).parse(process.env);
const split = (value: string) => value.split(',').map(part => part.trim()).filter(Boolean);
// stdout is not a protocol channel here, but keep every log on stderr as JSON.
console.log = console.error;
console.info = console.error;

const auth = await TokenAuth.fromFile(path.join(config.CONFIG_DIR, 'auth.json'));
const client = await loadClient(path.join(config.CONFIG_DIR, 'client.json'));
const file = await loadAccounts(path.join(config.CONFIG_DIR, 'accounts.json'));
const accounts = file.accounts.map(account => ({ name: account.name, email: account.email, gmail: googleGmail(client, account) }));
const listener = await startHttp({
  accounts, auth, host: config.HTTP_HOST, port: config.PORT,
  allowedHosts: split(config.HTTP_ALLOWED_HOSTS), allowedOrigins: split(config.HTTP_ALLOWED_ORIGINS),
  maxHttpRequests: config.MAX_HTTP_REQUESTS, maxHttpConnections: config.MAX_HTTP_CONNECTIONS,
});
console.error(JSON.stringify({ event: 'http_listening', host: config.HTTP_HOST, port: listener.port, accounts: accounts.map(account => account.name) }));
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try { await listener.close(); }
  catch (error) {
    console.error(JSON.stringify({ event: 'shutdown_failed', error: errorMessage(error) }));
    process.exitCode = 1;
  }
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
