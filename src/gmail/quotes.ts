// Heuristic removal of quoted earlier messages from plain-text replies.

const ATTRIBUTION = /^\s*On\b.{0,400}\bwrote:\s*$/i;
const ORIGINAL = /^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i;
const UNDERSCORES = /^\s*_{10,}\s*$/;
const OUTLOOK_FROM = /^\s*\*?From:\*?\s+\S/i;
const OUTLOOK_NEXT = /^\s*\*?(Sent|Date|To|Subject|Cc):\*?\s/i;

function cutIndex(lines: string[]): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    // Gmail and Apple Mail wrap long attributions over two lines.
    if (ATTRIBUTION.test(line) || (/^\s*On\b/i.test(line) && !/wrote:/i.test(line) && ATTRIBUTION.test(`${line} ${next}`))) return i;
    if (ORIGINAL.test(line)) return i;
    if (UNDERSCORES.test(line) && OUTLOOK_FROM.test(next)) return i;
    if (OUTLOOK_FROM.test(line) && OUTLOOK_NEXT.test(next)) return i;
  }
  return undefined;
}

export function stripQuotedText(text: string): { text: string; quoteStripped: boolean } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let kept = lines;
  const cut = cutIndex(lines);
  if (cut !== undefined) kept = lines.slice(0, cut);
  // Then drop the trailing block of "> " quoted lines (bottom-posted quotes, interleaved ones are kept).
  let end = kept.length;
  while (end > 0 && /^\s*(>.*)?$/.test(kept[end - 1]!)) end--;
  const tail = kept.slice(end);
  if (tail.some(line => /^\s*>/.test(line))) kept = kept.slice(0, end);
  const result = kept.join('\n').replace(/\s+$/, '');
  // A forward or a reply with nothing new: keep the original rather than returning nothing.
  if (!result.trim()) return { text: text.trim(), quoteStripped: false };
  return { text: result, quoteStripped: result.length < text.trim().length };
}
