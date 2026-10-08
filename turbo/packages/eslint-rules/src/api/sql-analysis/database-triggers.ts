const CREATE_TRIGGER =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:CONSTRAINT|EVENT)\s+)?TRIGGER\b/giu;

function blockCommentEnd(source: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < source.length && depth > 0) {
    if (source.startsWith("/*", index)) {
      depth++;
      index += 2;
    } else if (source.startsWith("*/", index)) {
      depth--;
      index += 2;
    } else {
      index++;
    }
  }
  return index;
}

function quotedEnd(source: string, start: number, quote: string): number {
  // PostgreSQL E'...' strings additionally allow backslash escapes.
  const escaped = quote === "'" && /\bE$/iu.test(source.slice(0, start));
  let index = start + 1;
  while (index < source.length) {
    if (escaped && source[index] === "\\") {
      index += 2;
    } else if (source[index] === quote) {
      if (source[index + 1] !== quote) {
        return index + 1;
      }
      index += 2;
    } else {
      index++;
    }
  }
  return source.length;
}

function quotedBody(source: string, escaped: boolean): string {
  // Pad decoded escapes so diagnostics retain their original source offsets.
  const escapes: Record<string, string> = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    "\\": "\\",
    "'": "'",
  };
  return source.replace(/''|\\[bfnrt\\']/gu, (match) => {
    if (match === "''") {
      return "' ";
    }
    return escaped ? escapes[match[1]] + " " : match;
  });
}

// Preserve offsets while hiding comments, quoted identifiers and data strings.
// Inspect procedure/DO bodies and literal EXECUTE SQL, which can also create
// triggers. This is a static guard, not an interpreter for computed SQL.
function executableSql(source: string): string {
  const parts: string[] = [];
  let index = 0;
  let prefix = "";
  while (index < source.length) {
    let end: number | undefined;
    if (source.startsWith("--", index)) {
      const newline = source.slice(index).search(/[\r\n]/u);
      end = newline < 0 ? source.length : index + newline;
    } else if (source.startsWith("/*", index)) {
      end = blockCommentEnd(source, index);
    }
    if (end !== undefined) {
      parts.push(" ".repeat(end - index));
      prefix += " ";
      index = end;
      continue;
    }

    const quote = source[index];
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u.exec(
      source.slice(index),
    )?.[0];
    if (quote === "'" || quote === '"' || dollar) {
      const width = dollar?.length ?? 1;
      const bodyStart = index + width;
      const closing = dollar ? source.indexOf(dollar, bodyStart) : -1;
      end = dollar
        ? closing < 0
          ? source.length
          : closing + width
        : quotedEnd(source, index, quote);
      const bodyEnd = Math.max(bodyStart, end - width);
      const isSqlBody =
        quote !== '"' &&
        /\b(?:DO(?:\s+LANGUAGE\s+(?:[A-Za-z_][A-Za-z_0-9]*|"(?:""|[^"])+"))?|AS|EXECUTE(?:\s+(?:pg_catalog\.)?format)?\s*(?:\(\s*)*)\s*(?:E)?$/iu.test(
          prefix,
        );
      const body = source.slice(bodyStart, bodyEnd);
      parts.push(
        isSqlBody
          ? " ".repeat(width) +
              executableSql(
                dollar ? body : quotedBody(body, /\bE$/iu.test(prefix)),
              ) +
              " ".repeat(end - bodyEnd)
          : " ".repeat(end - index),
      );
      prefix += quote === '"' ? source.slice(index, end) : " literal ";
      index = end;
      continue;
    }
    parts.push(source[index]);
    prefix += source[index];
    index++;
  }
  return parts.join("");
}

export function databaseTriggerOffsets(source: string): number[] {
  return Array.from(executableSql(source).matchAll(CREATE_TRIGGER), (match) => {
    return match.index;
  });
}
