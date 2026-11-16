// Plain-text RFC 2822/5322 message construction for drafts. No attachments, no HTML.

const CRLF = '\r\n';
const MAX_ENCODED_WORD = 75;
const ADDR_SPEC = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MESSAGE_ID = /^<[^<>\s]{1,995}>$/;

export class MimeError extends Error {}

export function assertNoLineBreaks(value: string, field: string): void {
  // Header injection: any CR, LF or NUL would let input start a new header or body.
  if (/[\r\n\0]/.test(value)) throw new MimeError(`${field} must not contain line breaks`);
}

const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** RFC 2047 B-encoding, split into encoded-words of at most 75 characters without splitting code points. */
export function encodeWords(value: string): string[] {
  const prefix = '=?UTF-8?B?';
  const suffix = '?=';
  const maxBytes = Math.floor((MAX_ENCODED_WORD - prefix.length - suffix.length) / 4) * 3;
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > maxBytes) {
      words.push(prefix + Buffer.from(chunk, 'utf8').toString('base64') + suffix);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk || !words.length) words.push(prefix + Buffer.from(chunk, 'utf8').toString('base64') + suffix);
  return words;
}

/** Unstructured header text (e.g. Subject): ASCII as-is, otherwise folded encoded-words. */
export function encodeText(value: string, field: string): string {
  assertNoLineBreaks(value, field);
  if (isAscii(value)) return value;
  return encodeWords(value).join(CRLF + ' ');
}

export type Address = { name?: string; address: string };

export function parseAddress(input: string, field = 'Address'): Address {
  assertNoLineBreaks(input, field);
  const value = input.trim();
  const angle = /^(.*?)\s*<([^<>]*)>$/.exec(value);
  const address = (angle ? angle[2] : value)?.trim() ?? '';
  if (!ADDR_SPEC.test(address) || address.length > 254) throw new MimeError(`${field} is not a valid email address`);
  let name = angle?.[1]?.trim() ?? '';
  if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  return name ? { name, address } : { address };
}

/** Split an RFC 5322 address-list header on commas outside quotes, comments and angle brackets. */
export function splitAddressList(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (quoted) {
      current += char;
      if (char === '\\' && i + 1 < header.length) current += header[++i];
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '<') angle++;
    else if (char === '>') angle = Math.max(0, angle - 1);
    else if (char === '(') comment++;
    else if (char === ')') comment = Math.max(0, comment - 1);
    else if (char === ',' && !angle && !comment) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.replace(/\([^()]*\)/g, ' ').trim()).filter(Boolean);
}

export function formatAddress({ name, address }: Address): string {
  if (!name) return address;
  if (!isAscii(name)) return `${encodeWords(name).join(' ')} <${address}>`;
  // Quote unless the name is a plain sequence of atext words.
  const display = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `${display} <${address}>`;
}

function validAddress(input: string | Address, field: string): Address {
  if (typeof input === 'string') return parseAddress(input, field);
  if (/[<>]/.test(input.address)) throw new MimeError(`${field} is not a valid email address`);
  const { address } = parseAddress(input.address, field);
  if (input.name) assertNoLineBreaks(input.name, field);
  return input.name ? { name: input.name, address } : { address };
}

export function formatAddressList(addresses: readonly (string | Address)[], field: string): string {
  return addresses.map(input => formatAddress(validAddress(input, field))).join(',' + CRLF + ' ');
}

export function assertMessageIds(value: string, field: string): string {
  assertNoLineBreaks(value, field);
  const ids = value.trim().split(/\s+/).filter(Boolean);
  if (!ids.length || ids.some(id => !MESSAGE_ID.test(id))) throw new MimeError(`${field} must be one or more <message-id> values`);
  return ids.join(' ');
}

/** Decode RFC 2047 encoded-words (B and Q) for display, falling back to the raw text. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
    .replace(/=\?([^?\s*]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g, (word, charset: string, encoding: string, text: string) => {
      try {
        const bytes = encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch { return word; }
    });
}

export type DraftMessage = {
  to: readonly (string | Address)[];
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  subject?: string | undefined;
  body: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
};

export function buildMessage(message: DraftMessage): string {
  if (!message.to.length && !message.cc?.length && !message.bcc?.length) throw new MimeError('At least one recipient is required');
  const headers: string[] = ['MIME-Version: 1.0'];
  if (message.to.length) headers.push(`To: ${formatAddressList(message.to, 'To')}`);
  if (message.cc?.length) headers.push(`Cc: ${formatAddressList(message.cc, 'Cc')}`);
  if (message.bcc?.length) headers.push(`Bcc: ${formatAddressList(message.bcc, 'Bcc')}`);
  headers.push(`Subject: ${encodeText(message.subject ?? '', 'Subject')}`);
  if (message.inReplyTo) headers.push(`In-Reply-To: ${assertMessageIds(message.inReplyTo, 'In-Reply-To')}`);
  if (message.references) headers.push(`References: ${assertMessageIds(message.references, 'References').split(' ').join(CRLF + ' ')}`);
  headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  const body = Buffer.from(message.body.replace(/\r\n?|\n/g, CRLF), 'utf8').toString('base64').replace(/.{1,76}/g, line => line + CRLF);
  return headers.join(CRLF) + CRLF + CRLF + body;
}

export const toBase64Url = (raw: string) => Buffer.from(raw, 'utf8').toString('base64url');
