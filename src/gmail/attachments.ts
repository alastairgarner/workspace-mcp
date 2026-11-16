import { decodePart } from './body.js';
import type { Part } from './body.js';
import { htmlToText } from './html.js';
import type { Account } from './service.js';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_BYTES = 10 * 1024 * 1024;

// Gmail often labels attachments application/octet-stream; trust common extensions instead.
const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', ics: 'text/calendar',
  vcf: 'text/vcard', eml: 'message/rfc822', yaml: 'application/yaml', yml: 'application/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|ld\+json)$|message\/rfc822$)/;

export function effectiveMimeType(filename: string, declared: string | null | undefined): string {
  const type = (declared ?? '').toLowerCase().split(';')[0]!.trim();
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') return type;
  const extension = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || 'application/octet-stream';
}

export function attachmentKind(mimeType: string): 'text' | 'image' | 'binary' {
  if (IMAGE.has(mimeType)) return 'image';
  if (TEXT.test(mimeType)) return 'text';
  return 'binary';
}

function findPart(part: Part | undefined, partId: string): Part | undefined {
  if (!part) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, partId);
    if (found) return found;
  }
  return undefined;
}

export type AttachmentResult = {
  metadata: { account: string; messageId: string; partId: string; filename: string; mimeType: string; size: number; kind: 'text' | 'image' | 'binary'; truncated?: boolean };
  text?: string;
  base64?: string;
};

export async function getAttachment(account: Account, messageId: string, partId: string, options: { maxBytes: number; maxChars: number }): Promise<AttachmentResult> {
  const message = await account.gmail.getFullMessage(messageId);
  const part = findPart(message.payload ?? undefined, partId);
  if (!part || (part.parts?.length ?? 0) > 0) throw new Error(`No attachment part "${partId}" in message ${messageId}; use the partId from gmail_get_thread`);
  const filename = part.filename || '(unnamed)';
  const mimeType = effectiveMimeType(filename, part.mimeType);
  const kind = attachmentKind(mimeType);
  const declaredSize = part.body?.size ?? 0;
  // Refuse before downloading: Gmail allows 25 MB attachments and base64 inflates them by a third.
  if (declaredSize > options.maxBytes) throw new Error(`Attachment is ${declaredSize} bytes, over the ${options.maxBytes}-byte limit (maxBytes, at most ${MAX_BYTES})`);
  // Small parts arrive inline in body.data; larger ones need a fetch. attachmentId changes between fetches, so use this one.
  const data = part.body?.data ?? (part.body?.attachmentId ? await account.gmail.getAttachment(messageId, part.body.attachmentId) : undefined);
  if (data == null) throw new Error('Attachment has no content');
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.length > options.maxBytes) throw new Error(`Attachment is ${bytes.length} bytes, over the ${options.maxBytes}-byte limit`);
  const metadata = { account: account.name, messageId, partId, filename, mimeType, size: bytes.length, kind };
  if (kind === 'text') {
    const charsetPart: Part = { ...part, body: { data: bytes.toString('base64url') } };
    let text = decodePart(charsetPart);
    if (mimeType === 'text/html') text = htmlToText(text);
    const chars = Array.from(text);
    const truncated = chars.length > options.maxChars;
    return { metadata: { ...metadata, truncated }, text: truncated ? chars.slice(0, options.maxChars).join('') + '…' : text };
  }
  return { metadata, base64: bytes.toString('base64') };
}

export const attachmentUri = (r: AttachmentResult['metadata']) =>
  `gmail://${encodeURIComponent(r.account)}/messages/${encodeURIComponent(r.messageId)}/parts/${encodeURIComponent(r.partId)}/${encodeURIComponent(r.filename)}`;
