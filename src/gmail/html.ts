// Small, dependency-free HTML-to-text conversion for email bodies. Output is for reading, not rendering.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°',
  times: '×', divide: '÷', zwnj: '', zwj: '', shy: '', lrm: '', rlm: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});?/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED[body.toLowerCase()] ?? entity;
  });
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

/** Is this element a quoted earlier message from Gmail, Apple Mail, Outlook, Yahoo or Thunderbird? */
function isQuote(tag: string, attrs: string): boolean {
  if (tag === 'blockquote') return true;
  const classes = (attribute(attrs, 'class') ?? '').split(/\s+/);
  const id = attribute(attrs, 'id') ?? '';
  return classes.some(name => ['gmail_quote', 'gmail_extra', 'yahoo_quoted', 'moz-cite-prefix', 'protonmail_quote'].includes(name))
    || ['appendonsend', 'divRplyFwdMsg', 'mail-editor-reference-message-container', 'OLK_SRC_BODY_SECTION'].includes(id);
}

/** Remove quoted-reply elements (and everything after Outlook's reply separator) before conversion. */
export function removeQuotedHtml(html: string): { html: string; removed: boolean } {
  let out = '';
  let last = 0;
  let removed = false;
  let skipping: { tag: string; depth: number } | undefined;
  for (const match of html.matchAll(TAG)) {
    const [full, closing, rawTag, attrs = ''] = match;
    const index = match.index;
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (skipping) {
      if (tag === skipping.tag && !VOID.has(tag) && !full.endsWith('/>')) skipping.depth += closing ? -1 : 1;
      if (skipping.depth === 0) { skipping = undefined; last = index + full.length; }
      continue;
    }
    if (closing || VOID.has(tag)) continue;
    if (tag === 'div' && /^(appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)$/.test(attribute(attrs, 'id') ?? '')) {
      // Outlook puts the quoted message after this marker, often as siblings rather than children.
      out += html.slice(last, index);
      return { html: out, removed: true };
    }
    if (isQuote(tag, attrs)) {
      out += html.slice(last, index);
      removed = true;
      skipping = { tag, depth: 1 };
    }
  }
  if (!skipping) out += html.slice(last);
  return { html: out, removed };
}

// Paragraph-like blocks get a blank line around them; other blocks start on a new line.
const PARAGRAPH = new Set(['blockquote', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ol', 'p', 'pre', 'table', 'ul']);
const BLOCK = new Set(['address', 'article', 'aside', 'center', 'dd', 'div', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
  'form', 'header', 'main', 'nav', 'section', 'tbody', 'thead', 'tfoot', 'tr']);
const SKIP = new Set(['head', 'script', 'style', 'title', 'noscript', 'template', 'svg', 'object', 'iframe']);

export function htmlToText(html: string): string {
  let out = '';
  let last = 0;
  let skip: string | undefined;
  let pre = 0;
  let link: { href: string; start: number } | undefined;
  const text = (raw: string) => {
    const decoded = decodeEntities(raw);
    // Protect preformatted spacing from the final line trimming with non-breaking spaces.
    return pre ? decoded.replace(/\r\n?/g, '\n').replace(/[ \t]/g, '\u00a0') : decoded.replace(/[ \t\r\n\f]+/g, ' ');
  };
  const newlines = (count: number) => {
    const trailing = /\n*[ \t]*$/.exec(out)?.[0].split('\n').length ?? 1;
    if (out.trim()) out += '\n'.repeat(Math.max(0, count - (trailing - 1)));
  };
  for (const match of html.matchAll(TAG)) {
    const [full, closing, rawTag, attrs = ''] = match;
    const index = match.index;
    if (!skip) out += text(html.slice(last, index));
    last = index + full.length;
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (skip) { if (closing && tag === skip) skip = undefined; continue; }
    if (SKIP.has(tag) && !closing && !full.endsWith('/>')) { skip = tag; continue; }
    if (tag === 'pre') pre = Math.max(0, pre + (closing ? -1 : 1));
    if (tag === 'br') out += '\n';
    else if (tag === 'li') { newlines(1); if (!closing) out += '- '; }
    else if ((tag === 'td' || tag === 'th') && closing) out += '\t';
    else if (PARAGRAPH.has(tag)) newlines(2);
    else if (BLOCK.has(tag)) newlines(1);
    if (tag === 'a') {
      if (!closing) {
        const href = attribute(attrs, 'href');
        link = href && /^(https?:|mailto:)/i.test(href) ? { href, start: out.length } : undefined;
      } else if (link) {
        const label = out.slice(link.start).trim();
        const target = link.href.replace(/^mailto:/i, '');
        if (label && label !== target && label !== link.href) out += ` (${link.href})`;
        link = undefined;
      }
    } else if (tag === 'img' && !closing) {
      const alt = attribute(attrs, 'alt')?.trim();
      if (alt) out += `[${alt}]`;
    }
  }
  if (!skip) out += text(html.slice(last));
  return out
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, '').replace(/^ +/g, ''))
    .join('\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
