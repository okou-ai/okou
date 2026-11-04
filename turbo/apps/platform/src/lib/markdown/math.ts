import type { Root } from "hast";
import type {
  MarkedExtension,
  TokenizerAndRendererExtension,
  Tokens,
} from "marked";
import { visit } from "unist-util-visit";

export interface MarkdownMath {
  readonly displayMode: boolean;
  readonly raw: string;
  readonly source: string | null;
}

declare module "hast" {
  interface Data {
    math?: MarkdownMath;
  }
}

const MAX_SOURCE_LENGTH = 10_000;
const BLOCK_TOKEN = "okouMathBlock";
const INLINE_TOKEN = "okouMathInline";
const NEXT_BLOCK = /\n {0,3}(?:\\\[|\$\$)/u;
const INLINE = /^\\\(([^\n]*?)\\\)/u;
const BRACKET_BLOCK =
  /^ {0,3}\\\[(?:([^\n]*?)\\\][ \t]*(?:\n|$)|[ \t]*\n([\s\S]*?)^ {0,3}\\\][ \t]*(?:\n|$))/mu;
const DOLLAR_BLOCK =
  /^ {0,3}\$\$(?:([^\n]*?)\$\$[ \t]*(?:\n|$)|[ \t]*\n([\s\S]*?)^ {0,3}\$\$[ \t]*(?:\n|$))/mu;

interface MathToken {
  readonly raw: string;
  readonly source: string | null;
  readonly type: string;
}

function renderableSource(source: string): string | null {
  const trimmed = source.trim();
  return trimmed !== "" && trimmed.length <= MAX_SOURCE_LENGTH ? trimmed : null;
}

function blockMathToken(source: string): MathToken | undefined {
  const match = /^ {0,3}\\\[/u.test(source)
    ? BRACKET_BLOCK.exec(source)
    : /^ {0,3}\$\$/u.test(source)
      ? DOLLAR_BLOCK.exec(source)
      : null;
  if (match?.index === 0) {
    return {
      type: BLOCK_TOKEN,
      raw: match[0],
      source: renderableSource(match[1] ?? match[2] ?? ""),
    };
  }
  return undefined;
}

function inlineMathToken(source: string): MathToken | undefined {
  const match = INLINE.exec(source);
  return match
    ? {
        type: INLINE_TOKEN,
        raw: match[0],
        source: renderableSource(match[1] ?? ""),
      }
    : undefined;
}

/** Keep formula asterisks out of a display parser's emphasis boundary scan. */
export function maskMarkdownInlineMath(
  source: string,
  upstreamMask: string,
): string {
  let masked = upstreamMask;
  let from = 0;
  for (
    let start = source.indexOf(String.raw`\(`);
    start !== -1;
    start = source.indexOf(String.raw`\(`, from)
  ) {
    from = start + 2;
    let precedingSlashes = 0;
    for (let index = start - 1; index >= 0 && source[index] === "\\"; index--) {
      precedingSlashes++;
    }
    // Marked masks active escaped punctuation as ++. An opener inside code,
    // a link destination or HTML instead belongs to its existing block mask.
    if (
      precedingSlashes % 2 !== 0 ||
      upstreamMask.slice(start, start + 2) !== "++"
    ) {
      continue;
    }
    const formula = inlineMathToken(source.slice(start));
    if (formula) {
      masked =
        masked.slice(0, start) +
        "a".repeat(formula.raw.length) +
        masked.slice(start + formula.raw.length);
      from = start + formula.raw.length;
    }
  }
  return masked;
}

function embedMath(
  tree: Root,
  marker: string,
  formulas: readonly MarkdownMath[],
): void {
  visit(tree, "comment", (node, index, parent) => {
    if (index === undefined || !parent || !node.value.startsWith(marker)) {
      return;
    }
    const formula = formulas[Number(node.value.slice(marker.length))];
    if (!formula) {
      throw new Error("Markdown math marker is invalid");
    }
    parent.children[index] = {
      type: "element",
      tagName: formula.displayMode ? "div" : "span",
      properties: {},
      data: { math: formula },
      children: [{ type: "text", value: formula.raw }],
    };
  });
}

interface MarkdownMathContext {
  readonly embed: (tree: Root) => void;
  readonly extension: MarkedExtension;
}

export function createMarkdownMathContext(): MarkdownMathContext {
  const marker = `okou-math:${crypto.randomUUID()}:`;
  const formulas: MarkdownMath[] = [];
  const render = (token: Tokens.Generic): string => {
    const formula: MarkdownMath = {
      displayMode: token.type === BLOCK_TOKEN,
      raw:
        token.type === BLOCK_TOKEN ? token.raw.replace(/\n+$/u, "") : token.raw,
      source: typeof token.source === "string" ? token.source : null,
    };
    const index = formulas.push(formula) - 1;
    return `<!--${marker}${index}-->${formula.displayMode ? "\n" : ""}`;
  };
  const block: TokenizerAndRendererExtension = {
    name: BLOCK_TOKEN,
    level: "block",
    start(source) {
      return NEXT_BLOCK.exec(source)?.index;
    },
    tokenizer: blockMathToken,
    renderer: render,
  };
  const inline: TokenizerAndRendererExtension = {
    name: INLINE_TOKEN,
    level: "inline",
    start(source) {
      const index = source.indexOf(String.raw`\(`);
      return index === -1 ? undefined : index;
    },
    tokenizer: inlineMathToken,
    renderer: render,
  };
  return {
    extension: { extensions: [block, inline] },
    embed(tree) {
      embedMath(tree, marker, formulas);
    },
  };
}
