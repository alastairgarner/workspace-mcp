import { extractBody, header } from './body.js';
import type { Part } from './body.js';
import type { GmailClient, Message } from './client.js';
import type { Address } from './mime.js';
import { MimeError, buildMessage, parseAddress, splitAddressList, toBase64Url } from './mime.js';

export type Account = { name: string; email: string; gmail: GmailClient };

const CONCURRENCY = 5;

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const webBase = (account: Account) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}`;
export const threadLink = (account: Account, threadId: string) => `${webBase(account)}#all/${encodeURIComponent(threadId)}`;
export const draftLink = (account: Account, messageId: string) => `${webBase(account)}#drafts?compose=${encodeURIComponent(messageId)}`;

const isoDate = (message: Message | undefined) => {
  const ms = Number(message?.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
};

export type ThreadSummary = {
  account: string; threadId: string; subject: string; firstFrom: string; lastFrom: string; date?: string;
  messageCount: number; snippet: string; unread: boolean; link: string;
};

export async function searchThreads(accounts: readonly Account[], query: string, maxResults: number, pageToken?: string) {
  if (pageToken && accounts.length !== 1) throw new Error('pageToken requires a single account, not "all"');
  const errors: { account: string; message: string }[] = [];
  const pages = await Promise.all(accounts.map(async account => {
    try { return { account, page: await account.gmail.listThreads({ q: query, maxResults, pageToken }) }; }
    catch (error) { errors.push({ account: account.name, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  }));
  const refs = pages.flatMap(entry => entry ? entry.page.threads.map(thread => ({ account: entry.account, id: thread.id })) : []);
  const summaries = await mapLimit(refs, CONCURRENCY, async ({ account, id }): Promise<ThreadSummary | undefined> => {
    try {
      const thread = await account.gmail.getThread(id, 'metadata', ['Subject', 'From', 'Date']);
      const messages = thread.messages ?? [];
      const first = messages[0];
      const last = messages.at(-1);
      const date = isoDate(last);
      return {
        account: account.name, threadId: id,
        subject: header(first?.payload ?? undefined, 'Subject') ?? '',
        firstFrom: header(first?.payload ?? undefined, 'From') ?? '',
        lastFrom: header(last?.payload ?? undefined, 'From') ?? '',
        ...(date ? { date } : {}),
        messageCount: messages.length,
        snippet: last?.snippet ?? thread.snippet ?? '',
        unread: messages.some(message => message.labelIds?.includes('UNREAD')),
        link: threadLink(account, id),
      };
    } catch (error) {
      errors.push({ account: account.name, message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  });
  const threads = summaries.filter((value): value is ThreadSummary => !!value)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, maxResults);
  const nextPageToken = accounts.length === 1 ? pages[0]?.page.nextPageToken : undefined;
  return { threads, ...(nextPageToken ? { nextPageToken } : {}), ...(errors.length ? { errors } : {}) };
}

export async function getThread(account: Account, threadId: string, maxCharsPerMessage: number, maxMessages: number) {
  const thread = await account.gmail.getThread(threadId, 'full');
  const all = thread.messages ?? [];
  const kept = all.slice(-maxMessages);
  const messages = kept.map(message => {
    const payload: Part | undefined = message.payload ?? undefined;
    const body = extractBody(payload, maxCharsPerMessage);
    const date = isoDate(message);
    return {
      id: message.id ?? '',
      ...(date ? { date } : {}),
      from: header(payload, 'From') ?? '',
      to: header(payload, 'To') ?? '',
      ...(header(payload, 'Cc') ? { cc: header(payload, 'Cc') } : {}),
      subject: header(payload, 'Subject') ?? '',
      unread: !!message.labelIds?.includes('UNREAD'),
      attachments: body.attachments,
      body: body.text,
      bodyFormat: body.format,
      quoteStripped: body.quoteStripped,
      truncated: body.truncated,
    };
  });
  return {
    account: account.name, threadId, link: threadLink(account, threadId),
    messageCount: all.length, omittedEarlierMessages: all.length - kept.length, messages,
  };
}

export async function listLabels(account: Account) {
  const labels = await account.gmail.listLabels();
  return {
    account: account.name,
    labels: labels.flatMap(label => label.id ? [{ id: label.id, name: label.name ?? label.id, type: label.type ?? 'user' }] : [])
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
  };
}

export type DraftInput = {
  to?: string[] | undefined; cc?: string[] | undefined; bcc?: string[] | undefined;
  subject?: string | undefined; body: string; replyToMessageId?: string | undefined;
};

export async function createDraft(account: Account, input: DraftInput) {
  let to: (string | Address)[] = input.to ?? [];
  let subject = input.subject;
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (input.replyToMessageId) {
    const original = await account.gmail.getMessage(input.replyToMessageId, ['From', 'Reply-To', 'Subject', 'Message-ID', 'References']);
    const payload = original.payload ?? undefined;
    threadId = original.threadId ?? undefined;
    const messageId = header(payload, 'Message-ID')?.trim();
    if (messageId) {
      inReplyTo = messageId;
      references = [header(payload, 'References')?.trim(), messageId].filter(Boolean).join(' ');
    }
    if (!to.length) {
      const replyTo = header(payload, 'Reply-To') || header(payload, 'From');
      if (!replyTo) throw new MimeError('Original message has no Reply-To or From; pass "to" explicitly');
      to = splitAddressList(replyTo).map(entry => parseAddress(entry, 'Original sender'));
    }
    if (subject === undefined) {
      const original = header(payload, 'Subject') ?? '';
      subject = /^\s*re:/i.test(original) ? original : `Re: ${original}`.trim();
    }
  }
  const raw = buildMessage({ to, cc: input.cc, bcc: input.bcc, subject, body: input.body, inReplyTo, references });
  const draft = await account.gmail.createDraft(toBase64Url(raw), threadId);
  return {
    account: account.name, draftId: draft.id,
    ...(draft.messageId ? { messageId: draft.messageId } : {}),
    ...(draft.threadId ?? threadId ? { threadId: draft.threadId ?? threadId } : {}),
    to: to.map(entry => typeof entry === 'string' ? entry : entry.name ? `${entry.name} <${entry.address}>` : entry.address), subject: subject ?? '',
    link: draft.messageId ? draftLink(account, draft.messageId) : `${webBase(account)}#drafts`,
    sent: false,
  };
}
