import { Tokenizer, type MarkedExtension } from "marked";

import { maskMarkdownInlineMath } from "./math.ts";

const CJK_END =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const CJK_PUNCTUATION = /[\u00b7\u2010-\u2027\u3000-\u303f\uff00-\uffef]/u;
const OPENING_PUNCTUATION = /^\*+((?![\\*])[\p{P}\p{S}])/u;
const OPENING_RUN = /^\*+/u;
const CLOSING_RUN = /\*+$/u;
const ZERO_WIDTH_SPACE = "\u200b";

function maskRawBlocks(
  source: string,
  upstreamMask: string,
  tokenizer: Tokenizer,
): string {
  let masked = upstreamMask;
  let rawStart: number | undefined;
  let from = 0;
  for (const match of source.matchAll(/</gu)) {
    const start = match.index;
    if (start < from || upstreamMask[start] !== "[") {
      continue;
    }
    const tag = tokenizer.rules.inline.tag.exec(source.slice(start))?.[0];
    if (!tag) {
      continue;
    }
    from = start + tag.length;
    if (rawStart === undefined) {
      if (tokenizer.rules.other.startPreScriptTag.test(tag)) {
        rawStart = start;
      }
    } else if (tokenizer.rules.other.endPreScriptTag.test(tag)) {
      masked =
        masked.slice(0, rawStart) +
        "a".repeat(from - rawStart) +
        masked.slice(from);
      rawStart = undefined;
    }
  }
  return rawStart === undefined
    ? masked
    : masked.slice(0, rawStart) + "a".repeat(source.length - rawStart);
}

function maskBareUrls(
  source: string,
  upstreamMask: string,
  tokenizer: Tokenizer,
): string {
  let masked = upstreamMask;
  for (const match of source.matchAll(/(?:https?:\/\/|ftp:\/\/|www\.)/giu)) {
    const start = match.index;
    if (masked.slice(start, start + match[0].length) !== match[0]) {
      continue;
    }
    const link = Tokenizer.prototype.url.call(tokenizer, source.slice(start));
    if (link) {
      masked =
        masked.slice(0, start) +
        "a".repeat(link.raw.length) +
        masked.slice(start + link.raw.length);
    }
  }
  return masked;
}

function maskCjkBoundaries(source: string, upstreamMask: string): string {
  return upstreamMask
    .replace(
      /(\*+)((?![\\*])[\p{P}\p{S}])/gu,
      (raw: string, markers: string, punctuation: string, offset: number) => {
        // Escaped punctuation and protected spans have synthetic mask text.
        if (source.slice(offset, offset + raw.length) !== raw) {
          return raw;
        }
        return CJK_PUNCTUATION.test(punctuation) ||
          CJK_END.test(upstreamMask.slice(0, offset))
          ? markers + ZERO_WIDTH_SPACE.repeat(punctuation.length)
          : raw;
      },
    )
    .replace(
      /((?![\\*])[\p{P}\p{S}])(\*+)(.)?/gu,
      (
        raw: string,
        punctuation: string,
        markers: string,
        following: string | undefined,
        offset: number,
      ) => {
        const boundary = punctuation + markers;
        if (source.slice(offset, offset + boundary.length) !== boundary) {
          return raw;
        }
        const next = following ?? "";
        return CJK_PUNCTUATION.test(punctuation) || CJK_END.test(next)
          ? ZERO_WIDTH_SPACE.repeat(punctuation.length) + markers + next
          : raw;
      },
    );
}

/** Repair CJK flanking rules without changing authored text or parser offsets. */
export function createCjkEmphasisExtension(options: {
  readonly math: boolean;
}): MarkedExtension {
  return {
    tokenizer: {
      emStrong(source, maskedSource, previous = "") {
        const openingRun = OPENING_RUN.exec(source);
        if (!openingRun || previous === "*" || this.lexer.state.inRawBlock) {
          return false;
        }
        // Only Marked's same-width lexical view gets zero-width boundary
        // characters. The original source supplies every token's raw/text.
        const masked = maskedSource.slice(-source.length);
        const mathMasked = options.math
          ? maskMarkdownInlineMath(source, masked)
          : masked;
        const rawMasked = maskRawBlocks(source, mathMasked, this);
        const protectedSource = this.lexer.state.inLink
          ? rawMasked
          : maskBareUrls(source, rawMasked, this);
        const normalized = maskCjkBoundaries(source, protectedSource);
        const opening = OPENING_PUNCTUATION.exec(source);
        const punctuation = opening?.[1];
        const previousCharacter =
          punctuation &&
          protectedSource.startsWith(opening[0]) &&
          (CJK_PUNCTUATION.test(punctuation) || CJK_END.test(previous))
            ? ""
            : previous;
        if (normalized === protectedSource && previousCharacter === previous) {
          return false;
        }
        const state = { ...this.lexer.state };
        const token = Tokenizer.prototype.emStrong.call(
          this,
          source,
          normalized,
          previousCharacter,
        );
        if (!token) {
          return false;
        }
        const closingRun = CLOSING_RUN.exec(
          normalized.slice(0, token.raw.length),
        );
        if (!closingRun || closingRun[0].length < openingRun[0].length) {
          // Matching recursively lexes children; undo rejected speculative state.
          Object.assign(this.lexer.state, state);
          return false;
        }
        return token;
      },
    },
  };
}
