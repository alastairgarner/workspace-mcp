import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePart, extractBody } from '../src/gmail/body.js';
import type { Part } from '../src/gmail/body.js';
import { decodeEntities, htmlToText, removeQuotedHtml } from '../src/gmail/html.js';
import { stripQuotedText } from '../src/gmail/quotes.js';

const data = (value: string | Buffer) => (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');
const part = (mimeType: string, content: string | Buffer, charset?: string, extra: Partial<Part> = {}): Part => ({
  mimeType, filename: '',
  headers: [{ name: 'Content-Type', value: `${mimeType}${charset ? `; charset="${charset}"` : ''}` }],
  body: { data: data(content), size: Buffer.byteLength(content) },
  ...extra,
});

test('prefers text/plain inside multipart/alternative and lists attachments', () => {
  const payload: Part = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [part('text/plain', 'Plain body'), part('text/html', '<p>HTML body</p>')] },
      { partId: '1', mimeType: 'application/pdf', filename: 'invoice.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }], body: { attachmentId: 'att1', size: 12345 } },
      { partId: '2', mimeType: 'text/plain', filename: 'notes.txt', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'att2', size: 10 } },
    ],
  };
  const body = extractBody(payload, 1000);
  assert.equal(body.text, 'Plain body');
  assert.equal(body.format, 'plain');
  assert.deepEqual(body.attachments, [
    { partId: '1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 12345 },
    { partId: '2', filename: 'notes.txt', mimeType: 'text/plain', size: 10 },
  ]);
});

test('falls back to HTML when there is no usable text/plain part', () => {
  const payload: Part = { mimeType: 'multipart/alternative', parts: [part('text/plain', '  \n'), part('text/html', '<div>Hello <b>there</b></div><div>Second</div>')] };
  const body = extractBody(payload, 1000);
  assert.equal(body.format, 'html');
  assert.equal(body.text, 'Hello there\nSecond');
  assert.equal(extractBody(undefined, 10).format, 'none');
});

test('decodes using the part charset, with safe fallbacks', () => {
  assert.equal(decodePart(part('text/plain', Buffer.from([0x43, 0x61, 0x66, 0xe9]), 'iso-8859-1')), 'Café');
  assert.equal(decodePart(part('text/plain', Buffer.from([0x93, 0x68, 0x69, 0x94]), 'windows-1252')), '“hi”');
  assert.equal(decodePart(part('text/plain', Buffer.from('café', 'utf8'), 'UTF-8')), 'café');
  assert.equal(decodePart(part('text/plain', Buffer.from('日本', 'utf8'))), '日本');
  // Undeclared or bogus charset, non-UTF-8 bytes: Windows-1252 rather than replacement characters.
  assert.equal(decodePart(part('text/plain', Buffer.from([0x43, 0x61, 0x66, 0xe9]))), 'Café');
  assert.equal(decodePart(part('text/plain', Buffer.from([0x43, 0x61, 0x66, 0xe9]), 'x-bogus')), 'Café');
  const shiftJis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]);
  assert.equal(decodePart(part('text/plain', shiftJis, 'shift_jis')), '日本');
});

test('truncates by characters, not UTF-16 units', () => {
  const body = extractBody(part('text/plain', '🎉🎉🎉🎉'), 2);
  assert.equal(body.text, '🎉🎉…');
  assert.equal(body.truncated, true);
});

test('htmlToText handles blocks, lists, links, entities, scripts and pre', () => {
  const html = `<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body>
    <p>Hello&nbsp;&amp; welcome&#33; &#x1F600; &unknown;</p>
    <script>alert("x")</script><!-- comment <p>hidden</p> -->
    <ul><li>One</li><li>Two</li></ul>
    <p>See <a href="https://example.com/a?b=1&amp;c=2">the docs</a> or <a href="mailto:x@example.com">x@example.com</a>.</p>
    <table><tr><td>A</td><td>B</td></tr></table>
    <pre>  keep
    spacing</pre>
    <img src="x.png" alt="Logo"><br>end
  </body></html>`;
  assert.equal(htmlToText(html), [
    'Hello & welcome! 😀 &unknown;',
    '',
    '- One',
    '- Two',
    '',
    'See the docs (https://example.com/a?b=1&c=2) or x@example.com.',
    '',
    'A\tB',
    '',
    '  keep\n    spacing',
    '',
    '[Logo]',
    'end',
  ].join('\n'));
  assert.equal(decodeEntities('&lt;b&gt;&#0;&#xD800;'), '<b>');
});

test('removes Gmail, blockquote and Outlook quoted HTML', () => {
  const gmail = '<div dir="ltr">Thanks!</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Alice wrote:</div><blockquote class="gmail_quote"><div>Old <div>nested</div></div></blockquote></div><div>After</div>';
  const result = removeQuotedHtml(gmail);
  assert.equal(result.removed, true);
  assert.equal(htmlToText(result.html), 'Thanks!\n\nAfter');
  const outlook = '<div>New reply</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Bob</div><div>Old text</div>';
  assert.equal(htmlToText(removeQuotedHtml(outlook).html), 'New reply');
  const apple = '<div>Top</div><blockquote type="cite"><div>Quoted</div></blockquote>';
  assert.equal(htmlToText(removeQuotedHtml(apple).html), 'Top');
  const unbalanced = '<div>Top</div><blockquote>never closed';
  assert.equal(htmlToText(removeQuotedHtml(unbalanced).html), 'Top');
});

test('pure HTML forwards keep their content', () => {
  const payload = part('text/html', '<blockquote>Everything is quoted</blockquote>');
  const body = extractBody(payload, 1000);
  assert.equal(body.text, 'Everything is quoted');
  assert.equal(body.quoteStripped, false);
});

test('stripQuotedText removes Gmail attributions, > blocks and Outlook headers', () => {
  assert.deepEqual(stripQuotedText('Sounds good.\n\nOn Mon, 3 Nov 2026 at 10:00, Alice <alice@example.com> wrote:\n> Shall we meet?\n> Thanks'),
    { text: 'Sounds good.', quoteStripped: true });
  assert.equal(stripQuotedText('Yes.\n\nOn Mon, 3 Nov 2026 at 10:00, Alice Example <\nalice@example.com> wrote:\n> Hi').text, 'Yes.');
  assert.equal(stripQuotedText('Reply\n\n-----Original Message-----\nFrom: Bob\nSent: Monday\nOld').text, 'Reply');
  assert.equal(stripQuotedText('Reply\n________________________________\nFrom: Bob <bob@example.com>\nSent: Monday\nTo: Me\nSubject: X\n\nOld').text, 'Reply');
  assert.equal(stripQuotedText('Reply\n\nFrom: Bob <bob@example.com>\nSent: Monday, 3 November\nTo: Me\n\nOld').text, 'Reply');
  assert.equal(stripQuotedText('Reply\n\n> quoted\n>\n> more\n').text, 'Reply');
  // Interleaved answers are kept: only the trailing quote block goes.
  assert.equal(stripQuotedText('> Q1?\nA1\n> Q2?\nA2').text, '> Q1?\nA1\n> Q2?\nA2');
  // A message that is only a quote stays as is.
  assert.deepEqual(stripQuotedText('---------- Forwarded message ---------\nFrom: X\nHello'), { text: '---------- Forwarded message ---------\nFrom: X\nHello', quoteStripped: false });
  assert.deepEqual(stripQuotedText('No quotes here.'), { text: 'No quotes here.', quoteStripped: false });
});

test('extractBody strips quotes from text and converted HTML', () => {
  const plain = extractBody(part('text/plain', 'New\r\n\r\nOn Tue, Bob wrote:\r\n> old'), 1000);
  assert.deepEqual([plain.text, plain.quoteStripped], ['New', true]);
  const html = extractBody(part('text/html', '<p>New</p><p>On Tue, 4 Nov 2026, Bob &lt;bob@example.com&gt; wrote:</p><p>&gt; old</p>'), 1000);
  assert.deepEqual([html.text, html.quoteStripped], ['New', true]);
});

test('attachment types: Gmail octet-stream falls back to the extension', async () => {
  const { effectiveMimeType, attachmentKind } = await import('../src/gmail/attachments.js');
  assert.equal(effectiveMimeType('report.PDF', 'application/octet-stream'), 'application/pdf');
  assert.equal(effectiveMimeType('x.bin', 'application/octet-stream'), 'application/octet-stream');
  assert.equal(effectiveMimeType('x.txt', 'Text/Plain; charset=utf-8'), 'text/plain');
  assert.deepEqual(['text/csv', 'application/json', 'message/rfc822', 'image/png', 'image/svg+xml', 'application/pdf'].map(attachmentKind),
    ['text', 'text', 'text', 'image', 'binary', 'binary']);
});
