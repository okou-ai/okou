import anchorme from "anchorme";

/** A stretch of user-authored text, or a URL inside it. */
export type PlainTextSegment =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "url"; readonly value: string };

/** anchorme also confirms `ftp://` and `ftps://`; only http(s) is linked. */
const HTTP_PROTOCOL = /^https?:\/\/$/iu;
const ASCII_ALPHANUMERIC = /[A-Za-z0-9]/u;
const CJK_LETTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const HTTP_SCHEMES = ["https://", "http://"] as const;

/**
 * Where the URL starts once the scheme anchorme skipped over is put back.
 *
 * anchorme only reads `https://` as a scheme at a word boundary. `1.https://x`
 * therefore reports the bare host `x` instead, which the protocol filter then
 * drops. Recover the scheme when the text right before the token is exactly
 * that scheme, and the character before it cannot continue a word — so an
 * ordinal such as `1.https://x` links while `ahttps://x` and `3https://x`
 * stay text, matching anchorme's own reason for refusing them.
 */
function recoveredStart(text: string, start: number): number | undefined {
  for (const scheme of HTTP_SCHEMES) {
    const schemeStart = start - scheme.length;
    if (
      schemeStart < 0 ||
      text.slice(schemeStart, start).toLowerCase() !== scheme
    ) {
      continue;
    }
    const previous = schemeStart > 0 ? text[schemeStart - 1] : undefined;
    return previous !== undefined && ASCII_ALPHANUMERIC.test(previous)
      ? undefined
      : schemeStart;
  }
  return undefined;
}

/**
 * Drops a sentence that was typed straight onto the end of a pasted link.
 *
 * CJK characters are legal in an IRI, so `https://example.com/a的文档` cannot
 * be told from prose by grammar alone. Position separates the common cases: a
 * real IRI puts its non-ASCII after a structural delimiter — `/wiki/中文`,
 * `?q=中文` — while prose follows the link's last character with no delimiter
 * at all. So a CJK letter ends the URL only where it sits directly against an
 * ASCII letter or digit and nothing before it was already non-ASCII, which
 * leaves a path that mixes scripts, such as `/中文2024年报告`, untouched.
 *
 * The trade-off is a URL whose own path glues CJK to a digit, for example
 * `/2024年报告`: the link stops at `/2024` and the rest stays readable text.
 */
function withoutProseTail(url: string): string {
  let sawNonAscii = false;
  for (let index = 0; index < url.length; index += 1) {
    const character = url[index];
    const code = character?.codePointAt(0);
    if (code === undefined || code <= 0x7f) {
      continue;
    }
    const previous = url[index - 1];
    if (
      !sawNonAscii &&
      previous !== undefined &&
      ASCII_ALPHANUMERIC.test(previous) &&
      CJK_LETTER.test(character)
    ) {
      return url.slice(0, index);
    }
    sawNonAscii = true;
  }
  return url;
}

/**
 * Splits user-authored text into literal text and clickable http(s) URLs.
 *
 * Segments are sliced out of the original string by offset, so concatenating
 * their values reproduces the input exactly. Callers render the text segments
 * unchanged, which keeps literal Markdown, HTML and whitespace intact.
 *
 * Bare hosts such as `example.com` stay text: `confirmedByProtocol` keeps the
 * result to URLs the author actually wrote a scheme for.
 */
export function splitPlainTextUrls(text: string): readonly PlainTextSegment[] {
  const segments: PlainTextSegment[] = [];
  let offset = 0;
  for (const token of anchorme.list(text)) {
    if (token.isURL !== true) {
      continue;
    }
    const start =
      token.confirmedByProtocol === true
        ? HTTP_PROTOCOL.test(token.protocol ?? "")
          ? token.start
          : undefined
        : recoveredStart(text, token.start);
    if (start === undefined || start < offset) {
      continue;
    }
    const url = withoutProseTail(text.slice(start, token.end));
    if (start > offset) {
      segments.push({ type: "text", value: text.slice(offset, start) });
    }
    segments.push({ type: "url", value: url });
    offset = start + url.length;
  }
  if (offset < text.length) {
    segments.push({ type: "text", value: text.slice(offset) });
  }
  return segments;
}
