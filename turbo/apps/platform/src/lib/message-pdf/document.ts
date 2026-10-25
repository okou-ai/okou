import type { Element, Root, RootContent } from "hast";
import type {
  Content,
  ContentText,
  Node,
  Style,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";

import { parseMarkdownTree } from "../markdown/pipeline.ts";
import type { PdfAssets, PdfMathRenderer, PdfRasterImage } from "./types.ts";
import { pdfLink } from "./urls.ts";

const PAGE_WIDTH = 499;
const FIGURE_HEIGHT = 650;
const TABLE_FONT_SIZE = 9;
const TABLE_PADDING = 8;
const OMITTED_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "button",
  "svg",
  "path",
]);
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  "a",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "br",
  "small",
  "sub",
  "sup",
  "u",
  "mark",
  "input",
]);

export function parseMessagePdfTree(source: string): Root {
  return parseMarkdownTree(source, { math: true, mermaid: true });
}

function textOf(node: RootContent): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type !== "element" || node.data?.copyCode !== undefined) {
    return "";
  }
  return node.children.map(textOf).join("");
}

function picture(image: PdfRasterImage, width: number, link?: string): Content {
  return {
    image: image.dataUrl,
    fit: [Math.min(width, image.width * 0.75), FIGURE_HEIGHT],
    margin: [0, 5, 0, 9],
    ...(link ? { link } : {}),
  };
}

interface Context {
  readonly assets: PdfAssets;
  readonly renderMath: PdfMathRenderer;
  readonly baseUrl: string;
  readonly segmenter: Intl.Segmenter;
  readonly nextTextId: () => string;
}

/**
 * Convert the shared no-card tree into PDF primitives. Prose, links, lists,
 * tables and code remain real text; only images and diagrams are rasterized.
 * Inline visuals split a paragraph into text runs and standalone visual blocks.
 */
export function buildMessagePdfDocument(
  tree: Root,
  assets: PdfAssets,
  renderMath: PdfMathRenderer,
  baseUrl: string,
): TDocumentDefinitions {
  let textId = 0;
  const context: Context = {
    assets,
    renderMath,
    baseUrl,
    segmenter: new Intl.Segmenter(undefined, { granularity: "grapheme" }),
    nextTextId() {
      return `message-pdf-text-${textId++}`;
    },
  };
  return {
    pageSize: "A4",
    pageMargins: [48, 46, 48, 46],
    defaultStyle: {
      font: "NotoSans",
      fontSize: 10,
      color: "#202124",
      lineHeight: 1.3,
    },
    styles: {
      h1: { fontSize: 22, bold: true, margin: [0, 15, 0, 9] },
      h2: { fontSize: 18, bold: true, margin: [0, 13, 0, 8] },
      h3: { fontSize: 15, bold: true, margin: [0, 11, 0, 7] },
      h4: { fontSize: 13, bold: true, margin: [0, 10, 0, 6] },
      h5: { fontSize: 11, bold: true, margin: [0, 9, 0, 5] },
      h6: { fontSize: 10, bold: true, margin: [0, 8, 0, 5] },
    },
    content: blocks(tree.children, context, PAGE_WIDTH),
    pageBreakBefore(node, queries) {
      return Boolean(
        node.headlineLevel &&
        !queries.getFollowingNodesOnPage().some(isRenderedBlock) &&
        queries.getNodesOnNextPage().some(isRenderedBlock),
      );
    },
  };
}

function isRenderedBlock(node: Node): boolean {
  // Table/list containers can keep a position on the previous page even when
  // all of their visible children move. Only actual content keeps a heading.
  return Boolean(node.text || node.image || node.svg || node.canvas);
}

function inlineStyle(node: Element, inherited: Style): Style {
  switch (node.tagName) {
    case "b":
    case "strong": {
      return { ...inherited, bold: true };
    }
    case "i":
    case "em": {
      return { ...inherited, italics: true };
    }
    case "s":
    case "del": {
      return { ...inherited, decoration: "lineThrough" };
    }
    case "u": {
      return { ...inherited, decoration: "underline" };
    }
    case "code": {
      return {
        ...inherited,
        background: "#f1f3f4",
        fontSize: 9,
        fontFeatures: ["hwid"],
        preserveLeadingSpaces: true,
        preserveTrailingSpaces: true,
      };
    }
    case "sup": {
      return { ...inherited, sup: true, sub: false };
    }
    case "sub": {
      return { ...inherited, sub: true, sup: false };
    }
    default: {
      return inherited;
    }
  }
}

function omittedElement(node: Element): boolean {
  return (
    OMITTED_ELEMENTS.has(node.tagName) ||
    node.data?.copyCode !== undefined ||
    node.data?.colorPreview !== undefined
  );
}

function textRuns(
  text: string,
  context: Context,
  style: Style = {},
  link?: string,
): ContentText[] {
  const runs: ContentText[] = [];
  for (const { segment } of context.segmenter.segment(text)) {
    const font = /[\p{Emoji_Presentation}\uFE0F\u20E3]/u.test(segment)
      ? "NotoEmoji"
      : "NotoSans";
    const previous = runs.at(-1);
    if (previous?.font === font) {
      previous.text = String(previous.text) + segment;
    } else {
      runs.push({ text: segment, ...style, font, ...(link ? { link } : {}) });
    }
  }
  return runs;
}

function paragraph(
  nodes: readonly RootContent[],
  context: Context,
  width: number,
  style: Style = {},
): Content[] {
  const output: Content[] = [];
  let runs: ContentText[] = [];
  const flush = () => {
    if (
      runs.some((run) => {
        return String(run.text).trim() !== "";
      })
    ) {
      // pdfmake relocates text-node page metadata for identified nodes when
      // an unbreakable table row moves. Document-scoped IDs keep heading
      // pagination based on the visible page, not the temporary row context.
      const content: ContentText & { id: string } = {
        id: context.nextTextId(),
        text: runs,
        ...style,
        margin: [0, 0, 0, 7],
      };
      output.push(content);
    }
    runs = [];
  };
  const walk = (
    node: RootContent,
    inherited: Style,
    link?: string,
    preserveWhitespace = false,
  ): void => {
    if (node.type === "text") {
      runs.push(
        ...textRuns(
          preserveWhitespace
            ? node.value
            : node.value.replace(/[ \t\r\n]+/gu, " "),
          context,
          inherited,
          link,
        ),
      );
      return;
    }
    if (node.type !== "element" || omittedElement(node)) {
      return;
    }
    if (node.data?.math || node.data?.mermaid || node.tagName === "img") {
      flush();
      output.push(visual(node, context, width, link));
      return;
    }
    if (node.tagName === "br") {
      runs.push({ text: "\n" });
      return;
    }
    if (node.tagName === "input") {
      runs.push({ text: node.properties.checked ? "[x] " : "[ ] " });
      return;
    }
    const href =
      node.tagName === "a" && typeof node.properties.href === "string"
        ? pdfLink(node.properties.href, context.baseUrl)
        : link;
    const nextStyle = inlineStyle(node, inherited);
    const linkedStyle: Style = href
      ? { ...nextStyle, color: "#1557b0", decoration: "underline" }
      : nextStyle;
    for (const child of node.children) {
      walk(
        child,
        linkedStyle,
        href,
        preserveWhitespace || node.tagName === "code",
      );
    }
  };
  for (const node of nodes) {
    walk(node, {});
  }
  flush();
  return output;
}

function visual(
  node: Element,
  context: Context,
  width: number,
  link?: string,
): Content {
  const math = node.data?.math;
  if (math) {
    if (math.source === null) {
      throw new Error("PDF formula has no renderable source");
    }
    const formula = context.renderMath(math.source, math.displayMode);
    return {
      svg: formula.svg,
      fit: [
        Math.min(width, formula.width),
        Math.min(FIGURE_HEIGHT, formula.height),
      ],
      margin: [0, 4, 0, 8],
      ...(link ? { link } : {}),
    };
  }
  if (node.data?.mermaid) {
    const diagram = context.assets.diagrams.get(node.data.mermaid.code);
    if (!diagram) {
      throw new Error("PDF Mermaid diagram was not prepared");
    }
    return picture(diagram, width, link);
  }
  const source = node.properties.src;
  const image =
    typeof source === "string" ? context.assets.images.get(source) : undefined;
  if (!image) {
    throw new Error("PDF image was not prepared");
  }
  return picture(image, width, link);
}

function columnSpan(cell: Element): number {
  const span = Number(cell.properties.colSpan ?? 1);
  // HTML caps a column span at 1000. Do not allocate unbounded columns.
  return Number.isInteger(span) && span > 0 ? Math.min(span, 1000) : 1;
}

function shortTableCell(cell: Element, width: number): boolean {
  const charsPerLine = Math.floor(width / TABLE_FONT_SIZE);
  if (charsPerLine < 1) {
    return false;
  }
  let lines = 0;
  const visit = (node: RootContent): boolean => {
    if (node.type === "text") {
      // Allow for word wrapping and full-width glyphs rather than assuming
      // Latin average widths. Twenty lines leave room for a repeated header.
      lines += 2 * Math.ceil(node.value.length / charsPerLine);
      return true;
    }
    if (node.type !== "element" || node.data?.math || node.data?.mermaid) {
      return false;
    }
    if (node.tagName === "input") {
      lines += 2 * Math.ceil(4 / charsPerLine);
      return true;
    }
    if (node.tagName === "br") {
      lines++;
      return true;
    }
    return INLINE_ELEMENTS.has(node.tagName) && node.children.every(visit);
  };
  return cell.children.every(visit) && lines <= 20;
}

function tableWidths(
  cells: readonly Element[][],
  columns: number,
  width: number,
) {
  // Star columns honor the longest unbroken token's minimum width and can
  // exceed the page. Numeric widths keep wrapping inside the available area.
  const padding = Math.min(TABLE_PADDING, width / (columns * 4));
  const available = width - padding * 2 * (columns - 1);
  const minimum = Math.min(28, available / columns);
  const desired = Array.from({ length: columns }, () => {
    return minimum;
  });
  for (const row of cells) {
    let column = 0;
    for (const cell of row) {
      const span = columnSpan(cell);
      const length = Array.from(textOf(cell)).length;
      const preference =
        Math.min(width / 2, length * TABLE_FONT_SIZE + 4) / span;
      for (let offset = 0; offset < span; offset++) {
        const current = desired[column + offset];
        if (current === undefined) {
          throw new Error("PDF table column is outside its declared span");
        }
        desired[column + offset] = Math.max(current, preference);
      }
      column += span;
    }
  }
  const total = desired.reduce((sum, value) => {
    return sum + value - minimum;
  }, 0);
  const remaining = available - minimum * columns;
  const widths = desired.map((value) => {
    return (
      minimum +
      (total ? (remaining * (value - minimum)) / total : remaining / columns)
    );
  });
  return { widths, padding };
}

function table(node: Element, context: Context, width: number): Content {
  const rows: Element[] = [];
  for (const section of node.children) {
    if (section.type !== "element") {
      continue;
    }
    if (section.tagName === "tr") {
      rows.push(section);
    } else if (["thead", "tbody", "tfoot"].includes(section.tagName)) {
      rows.push(
        ...section.children.filter((child): child is Element => {
          return child.type === "element" && child.tagName === "tr";
        }),
      );
    }
  }
  const cells = rows.map((row) => {
    return row.children.filter((child): child is Element => {
      return child.type === "element" && ["th", "td"].includes(child.tagName);
    });
  });
  const columns = Math.max(
    0,
    ...cells.map((row) => {
      return row.reduce((sum, cell) => {
        return sum + columnSpan(cell);
      }, 0);
    }),
  );
  if (columns === 0) {
    throw new Error("PDF table has no usable cells");
  }
  const { widths, padding } = tableWidths(cells, columns, width);
  const headerRows = cells[0]?.every((cell) => {
    return cell.tagName === "th";
  })
    ? 1
    : 0;
  let keepRows = true;
  const body: TableCell[][] = cells.map((row) => {
    const result: TableCell[] = [];
    for (const cell of row) {
      const colSpan = columnSpan(cell);
      if (Number(cell.properties.rowSpan ?? 1) !== 1) {
        throw new Error("PDF tables with row spans are unsupported");
      }
      const alignment = cell.properties.align;
      const cellWidth =
        widths
          .slice(result.length, result.length + colSpan)
          .reduce((sum, value) => {
            return sum + value;
          }, 0) +
        padding * 2 * (colSpan - 1) -
        4;
      keepRows = keepRows && shortTableCell(cell, cellWidth);
      result.push({
        stack: blocks(cell.children, context, Math.max(1, cellWidth)),
        colSpan,
        bold: cell.tagName === "th",
        fillColor: cell.tagName === "th" ? "#f1f3f4" : undefined,
        margin: [2, 3, 2, 3],
        ...(alignment === "left" ||
        alignment === "center" ||
        alignment === "right"
          ? { alignment }
          : {}),
      });
      for (let index = 1; index < colSpan; index++) {
        result.push("");
      }
    }
    while (result.length < columns) {
      result.push("");
    }
    return result;
  });
  return {
    table: {
      widths,
      // Unbreakable rows taller than a page lose content in pdfmake. Only
      // enable this for tables with conservatively bounded, short text cells.
      dontBreakRows: keepRows,
      headerRows,
      keepWithHeaderRows: keepRows && headerRows ? 1 : 0,
      body,
    },
    layout: {
      hLineWidth(index, tableNode) {
        if (index === 0 || index === tableNode.table.body.length) {
          return 0;
        }
        return index === tableNode.table.headerRows ? 2 : 1;
      },
      vLineWidth: () => {
        return 0;
      },
      hLineColor: (index) => {
        return index === 1 ? "black" : "#aaa";
      },
      paddingLeft: (index) => {
        return index === 0 ? 0 : padding;
      },
      paddingRight: (index) => {
        return index === columns - 1 ? 0 : padding;
      },
    },
    fontSize: TABLE_FONT_SIZE,
    margin: [0, 4, 0, 10],
  };
}

function block(node: Element, context: Context, width: number): Content[] {
  if (omittedElement(node)) {
    return [];
  }
  if (node.data?.math || node.data?.mermaid || node.tagName === "img") {
    return [visual(node, context, width)];
  }
  if (/^h[1-6]$/u.test(node.tagName)) {
    const content = paragraph(node.children, context, width);
    return [
      {
        stack: content.map((child, index) => {
          if (
            typeof child === "object" &&
            !Array.isArray(child) &&
            index === content.length - 1
          ) {
            return { ...child, headlineLevel: Number(node.tagName.slice(1)) };
          }
          return child;
        }),
        style: node.tagName,
        // Use document-scoped paragraph IDs; per-message heading slugs can
        // collide when several responses are exported together.
      },
    ];
  }
  switch (node.tagName) {
    case "pre": {
      const code = node.children.find((child): child is Element => {
        return child.type === "element" && child.tagName === "code";
      });
      const text = textOf(code ?? node);
      return [
        {
          text: textRuns(text, context),
          fontFeatures: ["hwid"],
          fontSize: 8,
          wordBreak: "break-all",
          preserveLeadingSpaces: true,
          preserveTrailingSpaces: true,
          lineHeight: 1.25,
          background: "#f1f3f4",
          margin: [8, 6, 8, 10],
        },
      ];
    }
    case "ul":
    case "ol": {
      return list(node, context, width);
    }
    case "blockquote": {
      return [
        {
          stack: blocks(node.children, context, width - 18),
          color: "#5f6368",
          margin: [18, 4, 0, 10],
        },
      ];
    }
    case "table": {
      return [table(node, context, width)];
    }
    case "hr": {
      return [
        {
          canvas: [
            {
              type: "line",
              x1: 0,
              y1: 0,
              x2: width,
              y2: 0,
              lineWidth: 0.5,
              lineColor: "#dadce0",
            },
          ],
          margin: [0, 8, 0, 12],
        },
      ];
    }
    case "iframe":
    case "video":
    case "audio": {
      throw new Error("PDF contains an unsupported embedded media element");
    }
    default: {
      return blocks(node.children, context, width);
    }
  }
}

function list(node: Element, context: Context, width: number): Content[] {
  const items = node.children
    .filter((child): child is Element => {
      return child.type === "element" && child.tagName === "li";
    })
    .map((item) => {
      return {
        stack: blocks(item.children, context, Math.max(20, width - 20)),
      };
    });
  if (items.length === 0) {
    return [];
  }
  return node.tagName === "ol"
    ? [
        {
          ol: items,
          start:
            typeof node.properties.start === "number"
              ? node.properties.start
              : 1,
          margin: [0, 2, 0, 8],
        },
      ]
    : [{ ul: items, margin: [0, 2, 0, 8] }];
}

function blocks(
  nodes: readonly RootContent[],
  context: Context,
  width: number,
): Content[] {
  const result: Content[] = [];
  let inline: RootContent[] = [];
  const flush = () => {
    result.push(...paragraph(inline, context, width));
    inline = [];
  };
  for (const node of nodes) {
    if (
      node.type === "text" ||
      (node.type === "element" &&
        INLINE_ELEMENTS.has(node.tagName) &&
        !node.data?.math &&
        !node.data?.mermaid)
    ) {
      inline.push(node);
    } else if (node.type === "element") {
      flush();
      result.push(...block(node, context, width));
    }
  }
  flush();
  return result;
}
