import anchorme from "anchorme";

/** A stretch of user-authored text, or a URL inside it. */
export type PlainTextSegment =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "url"; readonly value: string };

/** anchorme also confirms `ftp://` and `ftps://`; only http(s) is linked. */
const HTTP_PROTOCOL = /^https?:\/\/$/iu;

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
    if (token.isURL !== true || token.confirmedByProtocol !== true) {
      continue;
    }
    if (!HTTP_PROTOCOL.test(token.protocol ?? "")) {
      continue;
    }
    if (token.start < offset) {
      continue;
    }
    if (token.start > offset) {
      segments.push({ type: "text", value: text.slice(offset, token.start) });
    }
    segments.push({ type: "url", value: text.slice(token.start, token.end) });
    offset = token.end;
  }
  if (offset < text.length) {
    segments.push({ type: "text", value: text.slice(offset) });
  }
  return segments;
}
