interface KotlinToken {
  readonly text: string;
  readonly offset: number;
  readonly string: boolean;
}

/** Formatting-independent drift comparison; comments and strings are not code. */
export function kotlinTokens(source: string): KotlinToken[] {
  const tokens: KotlinToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/u.test(source[offset]!)) {
      offset++;
    } else if (source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset);
      offset = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", offset)) {
      offset = commentEnd(source, offset);
    } else {
      const start = offset;
      const delimiter = source.startsWith('"""', offset)
        ? '"""'
        : source[offset];
      const quoted =
        delimiter === '"' || delimiter === "'" || delimiter === '"""';
      if (quoted) {
        offset += delimiter.length;
        while (
          offset < source.length &&
          !source.startsWith(delimiter, offset)
        ) {
          offset += delimiter !== '"""' && source[offset] === "\\" ? 2 : 1;
        }
        if (offset >= source.length)
          throw new Error("Unterminated Kotlin string");
        offset += delimiter.length;
      } else {
        const word = /^[A-Za-z_0-9]+/u.exec(source.slice(offset))?.[0];
        offset += word?.length ?? 1;
      }
      tokens.push({
        text: source.slice(start, offset),
        offset: start,
        string: quoted,
      });
    }
  }
  return tokens;
}

function commentEnd(source: string, start: number): number {
  let depth = 1;
  let offset = start + 2;
  while (offset < source.length && depth > 0) {
    if (source.startsWith("/*", offset)) {
      depth++;
      offset += 2;
    } else if (source.startsWith("*/", offset)) {
      depth--;
      offset += 2;
    } else offset++;
  }
  if (depth !== 0) throw new Error("Unterminated Kotlin comment");
  return offset;
}
