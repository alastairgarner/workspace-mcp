import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasErrorCode } from './errors.js';

const MAX_CONFIG_BYTES = 64 * 1024;

export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const accountNameSchema = z.string().regex(ACCOUNT_NAME, 'Account names are 1–64 letters, numbers, underscores or hyphens, starting with a letter or number')
  .refine(name => name !== 'all', '"all" is reserved');

export const clientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }).passthrough(),
}).passthrough();
export type OAuthClient = { clientId: string; clientSecret: string };

const accountSchema = z.object({
  name: accountNameSchema,
  email: z.email(),
  refreshToken: z.string().min(1).max(4096),
}).strict();
export type AccountConfig = z.output<typeof accountSchema>;

export const accountsSchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountSchema).max(32),
}).strict().superRefine((value, ctx) => {
  const names = new Set<string>();
  for (const account of value.accounts) {
    if (names.has(account.name)) ctx.addIssue({ code: 'custom', message: `Duplicate account name ${account.name}` });
    names.add(account.name);
  }
});
export type AccountsFile = z.output<typeof accountsSchema>;

// Config is administrator-owned and loaded once. Errors never echo file content: it holds secrets.
export async function readJsonFile(file: string, label: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error(`${label} must be a regular file of at most 64 KiB`);
    const content = await handle.readFile();
    if (content.length > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds 64 KiB`);
    try { return JSON.parse(content.toString('utf8')); }
    catch { throw new Error(`${label} is not valid JSON`); }
  } finally { await handle.close(); }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  // Report paths and messages only, never input values.
  if (!parsed.success) throw new Error(`Invalid ${label}: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

export function parseClient(input: unknown): OAuthClient {
  const { installed } = parse(clientSchema, input, 'client.json (expected a Desktop app OAuth client with an "installed" key)');
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

export const parseAccounts = (input: unknown): AccountsFile => parse(accountsSchema, input, 'accounts.json');

export async function loadClient(file: string): Promise<OAuthClient> {
  return parseClient(await readJsonFile(file, 'client.json'));
}

export async function loadAccounts(file: string): Promise<AccountsFile> {
  return parseAccounts(await readJsonFile(file, 'accounts.json'));
}

export async function loadAccountsOrEmpty(file: string): Promise<AccountsFile> {
  try { return await loadAccounts(file); }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { version: 1, accounts: [] };
    throw error;
  }
}

export function upsertAccount(file: AccountsFile, account: AccountConfig): AccountsFile {
  const accounts = file.accounts.filter(existing => existing.name !== account.name);
  accounts.push(account);
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  return parseAccounts({ version: 1, accounts });
}

// Write to a private temporary file in the same directory, fsync, then rename over the target.
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.chmod(0o600);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  const dirHandle = await open(dir, constants.O_RDONLY);
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}
