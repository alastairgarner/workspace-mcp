import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MimeError, buildMessage, decodeWords, encodeText, encodeWords, formatAddress, parseAddress, splitAddressList, toBase64Url } from '../src/gmail/mime.js';

function parse(raw: string) {
  const [head = '', body = ''] = raw.split('\r\n\r\n');
  const unfolded = head.replace(/\r\n[ \t]/g, ' ');
  const headers = new Map(unfolded.split('\r\n').map(line => {
    const index = line.indexOf(':');
    return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()] as const;
  }));
  return { head, headers, body: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

test('builds a plain-text UTF-8 message with CRLF line endings', () => {
  const raw = buildMessage({ to: ['alice@example.com', 'Bob Smith <bob@example.org>'], cc: ['carol@example.net'], subject: 'Hello', body: 'Line 1\nLine 2\r\nLine 3' });
  const { headers, body, head } = parse(raw);
  assert.equal(headers.get('to'), 'alice@example.com, Bob Smith <bob@example.org>');
  assert.equal(headers.get('cc'), 'carol@example.net');
  assert.equal(headers.get('subject'), 'Hello');
  assert.equal(headers.get('content-type'), 'text/plain; charset=UTF-8');
  assert.equal(headers.get('content-transfer-encoding'), 'base64');
  assert.equal(headers.get('mime-version'), '1.0');
  assert.equal(body, 'Line 1\r\nLine 2\r\nLine 3');
  assert.ok(!/(^|[^\r])\n/.test(raw), 'every newline is CRLF');
  for (const line of head.split('\r\n')) assert.ok(line.length <= 998);
  assert.ok(raw.split('\r\n').every(line => line.length <= 998));
});

test('RFC 2047 encodes non-ASCII subjects and names without splitting code points', () => {
  const subject = 'Café meeting — 日本語のテキスト '.repeat(4) + '🎉';
  const encoded = encodeText(subject, 'Subject');
  for (const line of encoded.split('\r\n')) assert.ok(line.trim().length <= 75, line);
  assert.equal(decodeWords(encoded.replace(/\r\n /g, ' ')), subject);
  for (const word of encodeWords(subject)) assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(word.slice(10, -2), 'base64')));
  assert.equal(encodeText('Plain ASCII', 'Subject'), 'Plain ASCII');
  const raw = buildMessage({ to: ['Zoë Ångström <zoe@example.com>'], subject, body: 'x' });
  const { headers } = parse(raw);
  assert.match(headers.get('to') ?? '', /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.com>$/);
  assert.equal(decodeWords(headers.get('to') ?? ''), 'Zoë Ångström <zoe@example.com>');
});

test('decodes Q and B encoded-words in other charsets', () => {
  assert.equal(decodeWords('=?ISO-8859-1?Q?Caf=E9_cr=E8me?='), 'Café crème');
  assert.equal(decodeWords('=?utf-8?b?w6k=?= =?utf-8?b?w6k=?='), 'éé');
  assert.equal(decodeWords('no words here'), 'no words here');
});

test('quotes display names with specials', () => {
  assert.equal(formatAddress({ name: 'Smith, John', address: 'j@example.com' }), '"Smith, John" <j@example.com>');
  assert.equal(formatAddress({ name: 'Say "hi"', address: 'j@example.com' }), '"Say \\"hi\\"" <j@example.com>');
  assert.deepEqual(parseAddress('"Smith, John" <j@example.com>'), { name: 'Smith, John', address: 'j@example.com' });
});

test('rejects CR/LF header injection in every header field', () => {
  const injected = ['x\r\nBcc: evil@example.com', 'x\nBcc: evil@example.com', 'x\rBcc: evil@example.com', 'x\0y'];
  for (const value of injected) {
    assert.throws(() => buildMessage({ to: ['a@example.com'], subject: value, body: 'b' }), MimeError);
    assert.throws(() => buildMessage({ to: [`${value} <a@example.com>`], body: 'b' }), MimeError);
    assert.throws(() => buildMessage({ to: [{ name: value, address: 'a@example.com' }], body: 'b' }), MimeError);
    assert.throws(() => buildMessage({ to: ['a@example.com'], cc: [value], body: 'b' }), MimeError);
    assert.throws(() => buildMessage({ to: ['a@example.com'], inReplyTo: `<a@b>${value}`, body: 'b' }), MimeError);
    assert.throws(() => buildMessage({ to: ['a@example.com'], references: `<a@b> ${value}`, body: 'b' }), MimeError);
  }
  // Newlines in the body are content, not headers.
  const { headers, body } = parse(buildMessage({ to: ['a@example.com'], body: 'Hi\r\n\r\nBcc: evil@example.com' }));
  assert.equal(headers.has('bcc'), false);
  assert.match(body, /Bcc: evil/);
});

test('validates addresses', () => {
  for (const bad of ['', 'not-an-address', 'a@b', 'a@@example.com', 'a b@example.com', 'a@example.com, b@example.com', '<a@example.com', 'Name <a@example.com> extra', 'a@-example.com', 'Name <a@example.com>, b@example.com']) {
    assert.throws(() => parseAddress(bad), MimeError, bad);
  }
  assert.throws(() => buildMessage({ to: [{ address: 'x <a@example.com>' }], body: '' }), MimeError);
  assert.deepEqual(parseAddress('  a.b+tag@sub.example.co.uk '), { address: 'a.b+tag@sub.example.co.uk' });
  assert.throws(() => buildMessage({ to: [], body: 'x' }), /At least one recipient/);
});

test('splits address lists on commas outside quotes and angle brackets', () => {
  assert.deepEqual(splitAddressList('"Smith, John" <j@example.com>, b@example.com,<c@example.com> (comment, here)'),
    ['"Smith, John" <j@example.com>', 'b@example.com', '<c@example.com>']);
});

test('sets reply threading headers', () => {
  const raw = buildMessage({ to: ['a@example.com'], subject: 'Re: x', body: '', inReplyTo: '<m2@example.com>', references: '<m1@example.com> <m2@example.com>' });
  const { headers } = parse(raw);
  assert.equal(headers.get('in-reply-to'), '<m2@example.com>');
  assert.equal(headers.get('references'), '<m1@example.com> <m2@example.com>');
  assert.throws(() => buildMessage({ to: ['a@example.com'], inReplyTo: 'no-brackets@example.com', body: '' }), MimeError);
  assert.match(toBase64Url(raw), /^[A-Za-z0-9_-]+$/);
});
