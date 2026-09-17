const REDACTED_SECRET = "[REDACTED_SECRET]";
const PRIVATE_KEY_BEGIN_PREFIX = "-----BEGIN ";
const PRIVATE_KEY_LABEL_SUFFIX = " PRIVATE KEY";
const PRIVATE_KEY_MARKER_SUFFIX = "-----";
const PRIVATE_KEY_TYPE_MAX_LENGTH = 32;
const AUTHORIZATION_HEADER =
  /(\b(?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[^\s`"'<>]+/giu;
const COOKIE_HEADER = /(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/giu;
const URL_USER_INFO = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const PROVIDER_TOKEN =
  /(?<![A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9])/gu;
const SECRET_ASSIGNMENT =
  /((?:["'`]?)(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|cookie)(?:["'`]?)\s*(?::|=)\s*)(["'`]?)([^\s,;\r\n"'`]+)(["'`]?)/giu;

function privateKeyLabelAt(input: string, start: number): string | null {
  const labelStart = start + PRIVATE_KEY_BEGIN_PREFIX.length;
  const boundedMarker = input.slice(
    labelStart,
    labelStart +
      PRIVATE_KEY_TYPE_MAX_LENGTH +
      PRIVATE_KEY_LABEL_SUFFIX.length +
      PRIVATE_KEY_MARKER_SUFFIX.length,
  );
  const markerEnd = boundedMarker.indexOf(PRIVATE_KEY_MARKER_SUFFIX);
  if (markerEnd < 0) {
    return null;
  }
  const label = boundedMarker.slice(0, markerEnd);
  if (label === "PRIVATE KEY") {
    return label;
  }
  if (!label.endsWith(PRIVATE_KEY_LABEL_SUFFIX)) {
    return null;
  }
  const type = label.slice(0, -PRIVATE_KEY_LABEL_SUFFIX.length);
  if (type.length === 0 || type.length > PRIVATE_KEY_TYPE_MAX_LENGTH) {
    return null;
  }
  for (const character of type) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90))) {
      return null;
    }
  }
  return label;
}

/** Deterministic redaction for both Stage 1 trust boundaries. */
export function redactPiMemoryStage1Secrets(input: string): string {
  return redactPiMemoryStage1Segments([input]).join("");
}

/** Preserve segment provenance while removing secrets spanning SDK text blocks. */
export function redactPiMemoryStage1Segments(
  segments: readonly string[],
): string[] {
  const input = segments.join("");
  const ranges: { start: number; end: number }[] = [];
  for (const pattern of [
    AUTHORIZATION_HEADER,
    COOKIE_HEADER,
    URL_USER_INFO,
    PROVIDER_TOKEN,
    SECRET_ASSIGNMENT,
  ]) {
    for (const match of input.matchAll(pattern)) {
      const prefix = match[1]?.length ?? 0;
      const quote = pattern === SECRET_ASSIGNMENT ? (match[2]?.length ?? 0) : 0;
      const suffix =
        pattern === URL_USER_INFO
          ? 1
          : pattern === SECRET_ASSIGNMENT
            ? (match[4]?.length ?? 0)
            : 0;
      ranges.push({
        start: match.index + prefix + quote,
        end: match.index + match[0].length - suffix,
      });
    }
  }
  let cursor = 0;
  while (cursor < input.length) {
    const begin = input.indexOf(PRIVATE_KEY_BEGIN_PREFIX, cursor);
    if (begin < 0) break;
    const label = privateKeyLabelAt(input, begin);
    cursor = begin + PRIVATE_KEY_BEGIN_PREFIX.length;
    if (label === null) continue;
    const marker = `-----END ${label}-----`;
    const end = input.indexOf(marker, cursor + label.length);
    cursor = end < 0 ? input.length : end + marker.length;
    ranges.push({ start: begin, end: cursor });
  }
  ranges.sort((a, b) => {
    return a.start - b.start;
  });
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let offset = 0;
  let rangeIndex = 0;
  return segments.map((segment) => {
    const start = offset;
    offset += segment.length;
    let position = start;
    const parts: string[] = [];
    while (rangeIndex < merged.length) {
      const range = merged[rangeIndex];
      if (!range || range.start >= offset) break;
      if (range.end <= position) {
        rangeIndex += 1;
        continue;
      }
      parts.push(
        input.slice(position, Math.max(position, range.start)),
        REDACTED_SECRET,
      );
      position = Math.min(offset, range.end);
      if (range.end > offset) break;
      rangeIndex += 1;
    }
    parts.push(input.slice(position, offset));
    return parts.join("");
  });
}
