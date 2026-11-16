import { auth, gmail } from '@googleapis/gmail';
import type { gmail_v1 } from '@googleapis/gmail';
import type { AccountConfig, OAuthClient } from '../config.js';
import type { Part } from './body.js';

export const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'] as const;

export type Message = { id?: string | null; threadId?: string | null; labelIds?: string[] | null; snippet?: string | null; internalDate?: string | null; payload?: Part | null };
export type Thread = { id?: string | null; snippet?: string | null; messages?: Message[] | null };
export type Label = { id?: string | null; name?: string | null; type?: string | null; messagesTotal?: number | null; messagesUnread?: number | null; threadsUnread?: number | null };

/** The only Gmail operations the server uses. Deliberately no send, modify, trash or delete. */
export interface GmailClient {
  listThreads(params: { q: string; maxResults: number; pageToken?: string | undefined }): Promise<{ threads: { id: string }[]; nextPageToken?: string | undefined; resultSizeEstimate?: number | undefined }>;
  getThread(id: string, format: 'metadata' | 'full', metadataHeaders?: string[]): Promise<Thread>;
  getMessage(id: string, metadataHeaders: string[]): Promise<Message>;
  listLabels(): Promise<Label[]>;
  createDraft(raw: string, threadId?: string): Promise<{ id: string; messageId?: string | undefined; threadId?: string | undefined }>;
}

export class GoogleAuthError extends Error {}

/** Map expired or revoked refresh tokens to an actionable message; never include response bodies. */
export function mapGoogleError(error: unknown, account: string): Error {
  const record = error as { message?: unknown; response?: { data?: { error?: unknown } } } | null;
  const code = record?.response?.data?.error;
  const message = typeof record?.message === 'string' ? record.message : '';
  if (code === 'invalid_grant' || /invalid_grant/.test(message)) {
    return new GoogleAuthError(`Google access for account "${account}" has expired or been revoked. Re-run \`pnpm auth:google --account ${account}\` on your laptop and redeploy accounts.json.`);
  }
  const status = (error as { status?: unknown; code?: unknown } | null)?.status ?? (error as { code?: unknown } | null)?.code;
  return new Error(`Gmail API error for account "${account}"${typeof status === 'number' || typeof status === 'string' ? ` (${status})` : ''}: ${message || 'request failed'}`);
}

export function createOAuthClient(client: OAuthClient, redirectUri?: string) {
  return new auth.OAuth2({ clientId: client.clientId, clientSecret: client.clientSecret, ...(redirectUri ? { redirectUri } : {}) });
}

export function googleGmail(client: OAuthClient, account: AccountConfig): GmailClient {
  const oauth = createOAuthClient(client);
  oauth.setCredentials({ refresh_token: account.refreshToken });
  const api: gmail_v1.Gmail = gmail({ version: 'v1', auth: oauth, timeout: 20_000 });
  const wrap = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await call(); }
    catch (error) { throw mapGoogleError(error, account.name); }
  };
  return {
    listThreads: ({ q, maxResults, pageToken }) => wrap(async () => {
      const { data } = await api.users.threads.list({ userId: 'me', q, maxResults, ...(pageToken ? { pageToken } : {}) });
      return {
        threads: (data.threads ?? []).flatMap(thread => thread.id ? [{ id: thread.id }] : []),
        ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
        ...(data.resultSizeEstimate != null ? { resultSizeEstimate: data.resultSizeEstimate } : {}),
      };
    }),
    getThread: (id, format, metadataHeaders) => wrap(async () =>
      (await api.users.threads.get({ userId: 'me', id, format, ...(metadataHeaders ? { metadataHeaders } : {}) })).data),
    getMessage: (id, metadataHeaders) => wrap(async () =>
      (await api.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders })).data),
    listLabels: () => wrap(async () => (await api.users.labels.list({ userId: 'me' })).data.labels ?? []),
    createDraft: (raw, threadId) => wrap(async () => {
      const { data } = await api.users.drafts.create({ userId: 'me', requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } } });
      if (!data.id) throw new Error('Gmail returned no draft ID');
      return { id: data.id, ...(data.message?.id ? { messageId: data.message.id } : {}), ...(data.message?.threadId ? { threadId: data.message.threadId } : {}) };
    }),
  };
}
