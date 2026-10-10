/**
 * CJK-aware normalization shared by the chat search projector and the search
 * query path. Postgres' `simple` text-search configuration does not segment
 * CJK text, so both sides agree on this scheme instead: every CJK run is
 * expanded into space-separated character bigrams, while other alphanumeric
 * runs stay whole-word lowercase tokens.
 */

const TOKEN_PATTERN =
  /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)|((?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+)/gu;

interface ChatSearchTokenGroup {
  readonly kind: "cjk" | "word";
  readonly source: string;
  readonly start: number;
  readonly tokens: readonly string[];
}

interface ChatSearchMatchRange {
  /** UTF-16 code-unit offset, compatible with JavaScript String.slice. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset. */
  readonly end: number;
}

function cjkTokens(run: string): readonly string[] {
  const chars = Array.from(run);
  if (chars.length === 1) {
    return chars;
  }
  const bigrams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    bigrams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return bigrams;
}

function tokenGroups(text: string): readonly ChatSearchTokenGroup[] {
  const groups: ChatSearchTokenGroup[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const cjkRun = match[1];
    if (cjkRun !== undefined) {
      groups.push({
        kind: "cjk",
        source: cjkRun,
        start: match.index,
        tokens: cjkTokens(cjkRun),
      });
      continue;
    }
    const wordRun = match[2];
    if (wordRun !== undefined) {
      groups.push({
        kind: "word",
        source: wordRun,
        start: match.index,
        tokens: [wordRun.toLowerCase()],
      });
    }
  }
  return groups;
}

function literalMatchRanges(
  text: string,
  value: string,
): ChatSearchMatchRange[] {
  if (value.length === 0) {
    return [];
  }
  const ranges: ChatSearchMatchRange[] = [];
  let start = text.indexOf(value);
  while (start !== -1) {
    const end = start + value.length;
    ranges.push({ start, end });
    start = text.indexOf(value, end);
  }
  return ranges;
}

/**
 * Finds the query terms in the canonical display text returned by chat search.
 * Ranges use JavaScript string offsets so browser clients can slice the text
 * without translating PostgreSQL character positions.
 */
export function chatSearchMatchRanges(
  text: string,
  keyword: string,
): ChatSearchMatchRange[] {
  const queryGroups = tokenGroups(keyword);
  const textGroups = tokenGroups(text);
  const ranges =
    queryGroups.length === 0
      ? literalMatchRanges(text, keyword)
      : queryGroups.flatMap((queryGroup) => {
          if (queryGroup.kind === "cjk") {
            return literalMatchRanges(text, queryGroup.source);
          }
          const [queryToken] = queryGroup.tokens;
          return textGroups.flatMap((textGroup) => {
            const [textToken] = textGroup.tokens;
            return textGroup.kind === "word" && textToken === queryToken
              ? [
                  {
                    start: textGroup.start,
                    end: textGroup.start + textGroup.source.length,
                  },
                ]
              : [];
          });
        });
  ranges.sort((left, right) => {
    return left.start - right.start || left.end - right.end;
  });

  const merged: ChatSearchMatchRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/** Normalized form stored in both search projections during dual-writing. */
export function chatSearchIndexText(text: string): string {
  return tokenGroups(text)
    .flatMap((group) => {
      return group.tokens;
    })
    .join(" ");
}

/**
 * Builds a `to_tsquery('simple', ...)` expression for a keyword: bigrams of
 * one CJK run are chained with `<->` (adjacent-phrase, i.e. exact substring
 * semantics) and groups are combined with `&`. Returns null when the keyword
 * cannot be answered from the bigram index — a single-character CJK run or a
 * keyword with no indexable token.
 */
export function chatSearchBigramTsquery(keyword: string): string | null {
  const groups = tokenGroups(keyword);
  if (groups.length === 0) {
    return null;
  }
  const expressions: string[] = [];
  for (const group of groups) {
    if (group.kind === "cjk" && group.tokens.length === 1) {
      const [token] = group.tokens;
      if (token !== undefined && Array.from(token).length === 1) {
        return null;
      }
    }
    expressions.push(
      group.tokens.length === 1
        ? group.tokens.join("")
        : `(${group.tokens.join(" <-> ")})`,
    );
  }
  return expressions.join(" & ");
}
