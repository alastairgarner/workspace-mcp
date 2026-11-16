import { htmlToText, removeQuotedHtml } from './html.js';
import { stripQuotedText } from './quotes.js';
import { decodeWords } from './mime.js';

// Structural subset of gmail_v1.Schema$MessagePart, so fixtures need no Google types.
export type Part = {
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: Part[] | null;
};

export function header(part: Part | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  const value = part?.headers?.find(entry => entry.name?.toLowerCase() === lower)?.value;
  return value == null ? undefined : decodeWords(value);
}

function contentTypeParam(part: Part, param: string): string | undefined {
  const raw = part.headers?.find(entry => entry.name?.toLowerCase() === 'content-type')?.value ?? '';
  const match = new RegExp(`;\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(raw);
  return match?.[1] ?? match?.[2];
}

/** Decode a part's body bytes using its declared charset, falling back to UTF-8 then Windows-1252. */
export function decodePart(part: Part): string {
  const data = part.body?.data;
  if (!data) return '';
  const bytes = Buffer.from(data, 'base64url');
  const charset = contentTypeParam(part, 'charset')?.trim().toLowerCase();
  const candidates = [charset === 'us-ascii' || charset === 'ascii' ? 'windows-1252' : charset, 'utf-8'].filter((value): value is string => !!value);
  for (const label of candidates) {
    try { return new TextDecoder(label, { fatal: label === 'utf-8' && charset !== 'utf-8' }).decode(bytes); }
    catch { /* unknown label or invalid UTF-8: try the next */ }
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

function isAttachment(part: Part): boolean {
  const disposition = part.headers?.find(entry => entry.name?.toLowerCase() === 'content-disposition')?.value ?? '';
  return !!part.filename || /^\s*attachment/i.test(disposition) || !!part.body?.attachmentId;
}

export type Attachment = { filename: string; mimeType: string; size: number };

export function collect(payload: Part | undefined): { plain?: Part; html?: Part; attachments: Attachment[] } {
  const found: { plain?: Part; html?: Part; attachments: Attachment[] } = { attachments: [] };
  const walk = (part: Part) => {
    const type = (part.mimeType ?? '').toLowerCase();
    if (type.startsWith('multipart/') || part.parts?.length) {
      for (const child of part.parts ?? []) walk(child);
      return;
    }
    if (isAttachment(part)) {
      found.attachments.push({ filename: part.filename || '(unnamed)', mimeType: part.mimeType ?? 'application/octet-stream', size: part.body?.size ?? 0 });
      return;
    }
    // The first inline text part of each kind is the body; later ones are usually signatures or footers.
    if (type === 'text/plain' && !found.plain) found.plain = part;
    else if (type === 'text/html' && !found.html) found.html = part;
  };
  if (payload) walk(payload);
  return found;
}

export type ExtractedBody = { text: string; format: 'plain' | 'html' | 'none'; quoteStripped: boolean; truncated: boolean; attachments: Attachment[] };

export function extractBody(payload: Part | undefined, maxChars: number, stripQuotes = true): ExtractedBody {
  const { plain, html, attachments } = collect(payload);
  let text = '';
  let format: ExtractedBody['format'] = 'none';
  let quoteStripped = false;
  if (plain && decodePart(plain).trim()) {
    format = 'plain';
    text = decodePart(plain);
  } else if (html) {
    format = 'html';
    let source = decodePart(html);
    if (stripQuotes) {
      const removed = removeQuotedHtml(source);
      // Never strip everything: a pure forward is all quote.
      if (removed.removed && htmlToText(removed.html).trim()) { source = removed.html; quoteStripped = true; }
    }
    text = htmlToText(source);
  }
  if (stripQuotes && text) {
    const stripped = stripQuotedText(text);
    text = stripped.text;
    quoteStripped ||= stripped.quoteStripped;
  } else text = text.trim();
  const chars = Array.from(text);
  const truncated = chars.length > maxChars;
  if (truncated) text = chars.slice(0, maxChars).join('') + '…';
  return { text, format, quoteStripped, truncated, attachments };
}
