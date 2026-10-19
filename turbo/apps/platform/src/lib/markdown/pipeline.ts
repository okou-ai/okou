import type { Data, Element, ElementContent, Root, RootContent } from "hast";
import { Marked, Renderer, type Token, type Tokens } from "marked";
import { normalizeUri } from "micromark-util-sanitize-uri";
import rehypeAttrs from "rehype-attr";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeIgnore from "rehype-ignore";
import rehypePrism from "rehype-prism-plus/common";
import rehypeRaw from "rehype-raw";
import rehypeRewrite from "rehype-rewrite";
import rehypeSlug from "rehype-slug";
import { unified, type PluggableList } from "unified";
import { SKIP, visit } from "unist-util-visit";

import {
  collectText,
  MARKDOWN_MERMAID_FENCE_ATTRIBUTE,
  rehypeMermaid,
} from "../rehype-mermaid.ts";
import { findHexRgbColors } from "./hex-rgb-color.ts";
import { createMarkdownMathContext } from "./math.ts";
import { rehypeRewriteHandle } from "./uiw-nodes.ts";

/**
 * Markers the pipeline puts on a node so the view can swap it for a component.
 * They live on `data` rather than on properties because parsed HTML produces
 * properties only — quoted HTML therefore cannot impersonate a marker.
 */
declare module "hast" {
  interface Data {
    /** Set by `uiw-nodes`: the code a copy button copies. */
    copyCode?: string;
    /** A six-digit HEX RGB color shown by the adjacent preview marker. */
    colorPreview?: string;
    /** Set by `rehypeMermaid`: the diagram a placeholder stands for. */
    mermaid?: { code: string };
  }
}

/**
 * Markdown source becomes a hast tree here rather than inside a React render.
 *
 * `marked` produces HTML, `rehype-raw` turns it into the shared tree, and the
 * remaining rehype plugins add the application-owned behavior. Parsing
 * remains a plain function of the source so it can stay outside the React
 * render path. The view only turns the resulting tree into React elements.
 *
 * The rehype plugin order is load-bearing:
 *
 *   slug → autolinkHeadings → ignore → rewrite → attrs → colors → cards → mermaid → prism
 */

type MarkdownCard = NonNullable<Data["card"]>;

interface MarkdownParseOptions {
  /** Escape authored HTML tokens; code spans, fences and links keep their syntax. */
  readonly escapeHtml?: boolean;
  /** Recognize only explicit Agent-message math delimiters. */
  readonly math?: boolean;
  /**
   * Replace closed ```mermaid fences with diagram marker nodes. Only surfaces
   * whose trees are prepared by a command enable this — the command resolves
   * each marker's signals and embeds them. Without it, fences stay highlighted
   * code blocks.
   */
  readonly mermaid?: boolean;
  /**
   * Cards already registered for this document, keyed by slot URL. A paragraph
   * consisting of a single link whose href resolves here becomes the card; a
   * miss keeps the link. Keys go through `markdownCardKey`, which mirrors how
   * link destinations reach hast.
   */
  readonly cards?: ReadonlyMap<string, MarkdownCard>;
}

/** `mdast-util-to-hast` runs destinations through `normalizeUri`. */
export function markdownCardKey(url: string): string {
  return normalizeUri(url);
}

function loneAnchorHref(node: RootContent): string | undefined {
  if (node.type !== "element" || node.tagName !== "p") {
    return undefined;
  }
  const meaningful = node.children.filter((child) => {
    return !(child.type === "text" && child.value.trim() === "");
  });
  const anchor = meaningful.length === 1 ? meaningful[0] : undefined;
  if (anchor?.type !== "element" || anchor.tagName !== "a") {
    return undefined;
  }
  const href = anchor.properties.href;
  return typeof href === "string" ? href : undefined;
}

function rehypeCards(options: { cards: ReadonlyMap<string, MarkdownCard> }) {
  return (tree: Root): void => {
    tree.children = tree.children.map((node): RootContent => {
      const href = loneAnchorHref(node);
      const card = href === undefined ? undefined : options.cards.get(href);
      if (card === undefined) {
        return node;
      }
      return {
        type: "element",
        tagName: "div",
        properties: {},
        data: { card },
        children: [],
      };
    });
  };
}

/**
 * Neutralize raw HTML by escaping only `<`: a tag cannot start without it, so
 * escaping `<` alone stops tag injection. Leaving `>` intact preserves
 * Markdown block syntax that relies on a leading `>` — most importantly
 * blockquotes, which otherwise collapse into a literal `>` paragraph.
 */
export function escapeHtmlTags(source: string): string {
  return source.replace(/</g, "&lt;");
}

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/u;

function isMarkedCodeToken(token: Token): token is Tokens.Code {
  return (
    token.type === "code" && "text" in token && typeof token.text === "string"
  );
}

function isMermaidCodeToken(token: Token): token is Tokens.Code {
  if (!isMarkedCodeToken(token)) {
    return false;
  }
  return /^mermaid(?:\s|$)/u.test(token.lang?.trimStart() ?? "");
}

function isClosedFence(raw: string): boolean {
  const lines = raw.trimEnd().split("\n");
  const firstLine = lines.shift();
  if (firstLine === undefined) {
    throw new Error("Marked Mermaid token is missing its opening fence");
  }
  const opening = FENCE_OPENING.exec(firstLine)?.[1];
  if (opening === undefined) {
    throw new Error("Marked Mermaid token is missing its opening fence");
  }
  const closing = lines.at(-1);
  if (closing === undefined) {
    return false;
  }
  const trimmed = closing.replace(/^ {0,3}/u, "");
  return (
    trimmed.length >= opening.length &&
    [...trimmed].every((character) => {
      return character === opening[0];
    })
  );
}

function createMarkedRenderer(options: MarkdownParseOptions): Renderer {
  const renderer = new Renderer();
  if (options.escapeHtml) {
    renderer.html = (token) => {
      return escapeHtmlTags(token.text.replace(/&/g, "&amp;"));
    };
  }
  if (!options.mermaid) {
    return renderer;
  }
  const renderCode = renderer.code.bind(renderer);
  renderer.code = (token) => {
    const html = renderCode(token);
    if (!isMermaidCodeToken(token)) {
      return html;
    }
    if (!html.startsWith("<pre>")) {
      throw new Error("Marked changed its fenced-code HTML contract");
    }
    const state = isClosedFence(token.raw) ? "closed" : "open";
    return `<pre ${MARKDOWN_MERMAID_FENCE_ATTRIBUTE}="${state}">${html.slice("<pre>".length)}`;
  };
  return renderer;
}

/**
 * Rewrite callback that:
 * 1. Converts unknown HTML tags to plain text (e.g. <OrganizationSwitcher>)
 * 2. Strips auto-generated heading anchor links whose SVG icons get sanitized
 *    into visible `<svg>` text by rehype-sanitize.
 */
const VALID_HTML_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "meter",
  "nav",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
  // SVG elements (used by code-block copy button icons)
  "svg",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "g",
]);

const rewriteUnknownTags = rehypeRewriteHandle((node, _index, parent) => {
  // Raw HTML written at the top level of a document lands directly under the
  // hast root, so root-level nodes must be rewritten too — otherwise tags like
  // <style> and <script> survive into the app's DOM, where a generated
  // `* { margin: 0; padding: 0 }` reset unstyles the whole page.
  if (
    node.type === "element" &&
    !VALID_HTML_TAGS.has(node.tagName) &&
    (parent?.type === "element" || parent?.type === "root")
  ) {
    const inner = collectText(node);
    const text = inner
      ? `<${node.tagName}>${inner}</${node.tagName}>`
      : `<${node.tagName}>`;
    Object.assign(node, {
      type: "text",
      value: text,
      tagName: undefined,
      properties: undefined,
      children: undefined,
    });
    return;
  }

  // Strip heading anchor links (`.anchor` class) that contain escaped `<svg>`
  // text.
  if (
    node.type === "element" &&
    node.tagName === "a" &&
    node.properties.class === "anchor"
  ) {
    Object.assign(node, {
      type: "text",
      value: "",
      tagName: undefined,
      properties: undefined,
      children: undefined,
    });
  }
});

const COLOR_PREVIEW_EXCLUDED_TAGS: ReadonlySet<string> = new Set(["a", "pre"]);

function colorPreviewNode(color: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: {},
    data: { colorPreview: color },
    children: [],
  };
}

function inlineCodeColor(node: Element): string | undefined {
  if (node.children.length !== 1) {
    return undefined;
  }
  const child = node.children[0];
  if (child.type !== "text") {
    return undefined;
  }
  const [color] = findHexRgbColors(child.value);
  return color?.start === 0 && color.end === child.value.length
    ? color.color
    : undefined;
}

function colorPreviewChildren(value: string): readonly ElementContent[] {
  const colors = findHexRgbColors(value);
  if (colors.length === 0) {
    return [{ type: "text", value }];
  }

  const children: ElementContent[] = [];
  let offset = 0;
  for (const { color, start, end } of colors) {
    if (start > offset) {
      children.push({ type: "text", value: value.slice(offset, start) });
    }
    children.push({ type: "text", value: color }, colorPreviewNode(color));
    offset = end;
  }
  if (offset < value.length) {
    children.push({ type: "text", value: value.slice(offset) });
  }
  return children;
}

function rehypeColorPreviews() {
  return (tree: Root): void => {
    visit(tree, (node, index, parent) => {
      if (
        node.type === "element" &&
        COLOR_PREVIEW_EXCLUDED_TAGS.has(node.tagName)
      ) {
        return SKIP;
      }
      if (node.type === "element" && node.tagName === "code") {
        const color = inlineCodeColor(node);
        if (
          color !== undefined &&
          parent !== undefined &&
          index !== undefined &&
          (parent.type === "element" || parent.type === "root")
        ) {
          parent.children.splice(index + 1, 0, colorPreviewNode(color));
          return [SKIP, index + 2];
        }
        return SKIP;
      }
      if (node.type !== "text" || parent === undefined || index === undefined) {
        return undefined;
      }
      const children = colorPreviewChildren(node.value);
      if (children.length === 1) {
        return undefined;
      }
      if (parent.type === "element" || parent.type === "root") {
        parent.children.splice(index, 1, ...children);
        return index + children.length;
      }
      return undefined;
    });
  };
}

function rehypePlugins(options: MarkdownParseOptions): PluggableList {
  const cardPlugins: PluggableList = options.cards
    ? [[rehypeCards, { cards: options.cards }]]
    : [];
  const mermaidPlugins: PluggableList = options.mermaid ? [rehypeMermaid] : [];
  return [
    rehypeSlug,
    rehypeAutolinkHeadings,
    rehypeIgnore,
    [rehypeRewrite, { rewrite: rewriteUnknownTags }],
    [rehypeAttrs, { properties: "attr" }],
    rehypeColorPreviews,
    ...cardPlugins,
    ...mermaidPlugins,
    [rehypePrism, { ignoreMissing: true }],
  ];
}

/**
 * `react-markdown` ran this over the tree after the rehype chain, before
 * handing it to `hast-util-to-jsx-runtime`. It drops elements whose tag name
 * is not plain alphanumeric — which is what makes the mermaid placeholder use
 * a `div` — and turns any leftover raw node into text.
 *
 * The url-transform step is deliberately absent: `@uiw/react-markdown-preview`
 * passed an identity transform, so reproducing it would be a no-op.
 */
function postProcess(tree: Root): Root {
  visit(tree, (node, index, parent) => {
    // Authored link/image titles and raw HTML must not reintroduce browser hints.
    // Iframe titles identify embedded documents to assistive technology.
    if (node.type === "element" && node.tagName !== "iframe") {
      delete node.properties.title;
    }
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value };
      return index;
    }
    if (
      node.type === "element" &&
      parent &&
      typeof index === "number" &&
      !/^[A-Za-z0-9]+$/.test(node.tagName)
    ) {
      parent.children.splice(index, 1);
      return index;
    }
    return undefined;
  });
  return tree;
}

export function parseMarkdownTree(
  source: string,
  options: MarkdownParseOptions,
): Root {
  const math = options.math ? createMarkdownMathContext() : undefined;
  // Tiptap registers editor-only tokenizers on the global marked instance.
  // Keep display parsing independent of which editors have been opened.
  const parser = math ? new Marked(math.extension) : new Marked();
  const html = parser.parse(source, {
    async: false,
    renderer:
      options.mermaid || options.escapeHtml
        ? createMarkedRenderer(options)
        : null,
  });
  const tree: Root = {
    type: "root",
    children: [{ type: "raw", value: html }],
  };
  const processor = unified().use(rehypeRaw).use(rehypePlugins(options));
  const parsed = processor.runSync(tree, source);
  math?.embed(parsed);
  return postProcess(parsed);
}
