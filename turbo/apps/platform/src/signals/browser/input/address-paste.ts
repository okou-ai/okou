/** Chromium's address paste semantics: unwrap URLs, join prose and strip pasted JS. */
export function addressPaste(input: string): string {
  const text = input.trim();
  if (!text) {
    return input ? " " : "";
  }
  const hasSpaces = (text.match(/\s+/gu) ?? []).some((space) => {
    return !/[\r\n]/u.test(space);
  });
  const output = text.replace(/\s+/gu, (space) => {
    if (!/[\r\n]/u.test(space)) {
      return space;
    }
    return hasSpaces ? " " : "";
  });
  let cursor = 0;
  let removed = false;
  while (cursor < output.length) {
    const char = output[cursor]!;
    if (/\s/u.test(char) || char < " ") {
      cursor++;
    } else if (
      output.slice(cursor, cursor + 11).toLowerCase() === "javascript:"
    ) {
      cursor += 11;
      removed = true;
    } else {
      break;
    }
  }
  return removed ? output.slice(cursor) : output;
}
