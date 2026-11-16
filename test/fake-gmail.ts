import type { Part } from '../src/gmail/body.js';
import type { GmailClient, Message, Thread } from '../src/gmail/client.js';
import { mapGoogleError } from '../src/gmail/client.js';
import type { Account } from '../src/gmail/service.js';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

export function message(id: string, threadId: string, opts: { from: string; to?: string; subject: string; date: number; body: string; unread?: boolean; headers?: Record<string, string> }): Message {
  const headers = Object.entries({ From: opts.from, To: opts.to ?? 'me@example.com', Subject: opts.subject, 'Message-ID': `<${id}@mail.example.com>`, ...opts.headers })
    .map(([name, value]) => ({ name, value }));
  const payload: Part = { mimeType: 'text/plain', headers: [...headers, { name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64(opts.body), size: opts.body.length } };
  return { id, threadId, internalDate: String(opts.date), snippet: opts.body.slice(0, 50), labelIds: opts.unread ? ['INBOX', 'UNREAD'] : ['INBOX'], payload };
}

export const PDF = Buffer.from('%PDF-1.4\n%fake\n');
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CSV = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // "name\nCafé\n" in Latin-1

// Wrap a plain message as multipart/mixed with assorted attachments, numbered like Gmail's partIds.
function withAttachments(original: Message): Message {
  const body = { ...original.payload!, partId: '0' };
  const file = (partId: string, filename: string, mimeType: string, content: Partial<NonNullable<Part['body']>>, contentType = mimeType): Part => ({
    partId, filename, mimeType,
    headers: [{ name: 'Content-Type', value: contentType }, { name: 'Content-Disposition', value: `attachment; filename="${filename}"` }],
    body: content,
  });
  return { ...original, payload: { partId: '', mimeType: 'multipart/mixed', headers: original.payload!.headers ?? null, parts: [
    body,
    file('1', 'statement.pdf', 'application/octet-stream', { attachmentId: 'att-pdf', size: PDF.length }),
    file('2', 'chart.png', 'image/png', { attachmentId: 'att-png', size: PNG.length }),
    file('3', 'data.csv', 'text/csv', { data: CSV.toString('base64url'), size: CSV.length }, 'text/csv; charset=iso-8859-1'),
    file('4', 'page.html', 'text/html', { data: Buffer.from('<p>Hello <b>there</b></p>').toString('base64url'), size: 26 }),
    file('5', 'huge.zip', 'application/zip', { attachmentId: 'att-big', size: 30 * 1024 * 1024 }),
  ] } };
}

export class FakeGmail implements GmailClient {
  drafts: { raw: string; threadId?: string | undefined }[] = [];
  calls: string[] = [];
  revoked = false;
  constructor(private readonly name: string, readonly threads: Thread[]) {}

  private check(call: string) {
    this.calls.push(call);
    // Simulate gaxios' error shape for a revoked refresh token.
    if (this.revoked) throw mapGoogleError(Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } }), this.name);
  }

  async listThreads({ q, maxResults, pageToken }: { q: string; maxResults: number; pageToken?: string | undefined }) {
    this.check(`list:${q}:${pageToken ?? ''}`);
    const start = pageToken ? Number(pageToken) : 0;
    const page = this.threads.slice(start, start + maxResults);
    const next = start + maxResults < this.threads.length ? String(start + maxResults) : undefined;
    return { threads: page.map(thread => ({ id: thread.id! })), ...(next ? { nextPageToken: next } : {}) };
  }

  async getThread(id: string, format: 'metadata' | 'full') {
    this.check(`thread:${id}:${format}`);
    const thread = this.threads.find(candidate => candidate.id === id);
    if (!thread) throw new Error('Requested entity was not found.');
    return thread;
  }

  async getMessage(id: string) {
    this.check(`message:${id}`);
    const found = this.threads.flatMap(thread => thread.messages ?? []).find(candidate => candidate.id === id);
    if (!found) throw new Error('Requested entity was not found.');
    return found;
  }

  async getFullMessage(id: string) {
    return this.getMessage(id);
  }

  attachments = new Map<string, Buffer>();
  async getAttachment(messageId: string, attachmentId: string) {
    this.check(`attachment:${messageId}:${attachmentId}`);
    const bytes = this.attachments.get(attachmentId);
    if (!bytes) throw new Error('Requested entity was not found.');
    return bytes.toString('base64url');
  }

  async listLabels() {
    this.check('labels');
    return [{ id: 'Label_1', name: 'Receipts', type: 'user' }, { id: 'INBOX', name: 'INBOX', type: 'system' }];
  }

  async createDraft(raw: string, threadId?: string) {
    this.check('draft');
    this.drafts.push({ raw, threadId });
    return { id: `r-${this.drafts.length}`, messageId: `m-${this.drafts.length}`, ...(threadId ? { threadId } : {}) };
  }
}

export function fixtureAccounts() {
  const personal = new FakeGmail('personal', [
    { id: 't1', messages: [
      message('p1', 't1', { from: 'Alice <alice@example.com>', subject: 'Lunch?', date: Date.UTC(2026, 10, 1), body: 'Lunch on Friday?' }),
      message('p2', 't1', { from: 'Me <me@example.com>', subject: 'Re: Lunch?', date: Date.UTC(2026, 10, 2), body: 'Yes!\n\nOn Sun, Alice wrote:\n> Lunch on Friday?', unread: true,
        headers: { 'Reply-To': '"Smith, Alice" <alice.reply@example.com>', References: '<p1@mail.example.com>' } }),
    ] },
    { id: 't2', messages: [message('p3', 't2', { from: 'Shop <shop@example.com>', subject: 'Receipt', date: Date.UTC(2026, 9, 1), body: 'Thanks' })] },
  ]);
  personal.threads.push({ id: 't3', messages: [withAttachments(message('p4', 't3', { from: 'Bank <bank@example.com>', subject: 'Statement', date: Date.UTC(2026, 8, 1), body: 'Attached' }))] });
  personal.attachments.set('att-pdf', PDF);
  personal.attachments.set('att-png', PNG);
  personal.attachments.set('att-big', Buffer.alloc(10));
  const work = new FakeGmail('work', [
    { id: 'w1', messages: [message('w1m', 'w1', { from: 'Boss <boss@corp.example>', subject: 'Report', date: Date.UTC(2026, 10, 3), body: 'Send the report' })] },
  ]);
  const accounts: Account[] = [
    { name: 'personal', email: 'me@example.com', gmail: personal },
    { name: 'work', email: 'me@corp.example', gmail: work },
  ];
  return { accounts, personal, work };
}
