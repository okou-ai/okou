import type { Element, Root, RootContent } from "hast";
import type {
  Content,
  ContentText,
  Style,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";

import { parseMarkdownTree } from "../markdown/pipeline.ts";
import type { PdfAssets, PdfMathRenderer, PdfRasterImage } from "./types.ts";
import { pdfLink } from "./urls.ts";

const PAGE_WIDTH = 499;
const FIGURE_HEIGHT = 650;
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
  const context: Context = { assets, renderMath, baseUrl };
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
        node.headlineLevel && queries.getFollowingNodesOnPage().length === 0,
      );
    },
  };
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
      return { ...inherited, background: "#f1f3f4", fontSize: 9 };
    }
    case "sup":
    case "sub": {
      return { ...inherited, fontSize: 8 };
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
      output.push({ text: runs, ...style, margin: [0, 0, 0, 7] });
    }
    runs = [];
  };
  const walk = (node: RootContent, inherited: Style, link?: string): void => {
    if (node.type === "text") {
      runs.push({ text: node.value, ...inherited, ...(link ? { link } : {}) });
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
      walk(child, linkedStyle, href);
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
        return (
          sum +
          (typeof cell.properties.colSpan === "number"
            ? cell.properties.colSpan
            : 1)
        );
      }, 0);
    }),
  );
  if (columns === 0) {
    throw new Error("PDF table has no usable cells");
  }
  const body: TableCell[][] = cells.map((row) => {
    const result: TableCell[] = [];
    for (const cell of row) {
      const colSpan =
        typeof cell.properties.colSpan === "number"
          ? cell.properties.colSpan
          : 1;
      if (cell.properties.rowSpan && cell.properties.rowSpan !== 1) {
        throw new Error("PDF tables with row spans are unsupported");
      }
      const alignment = cell.properties.align;
      result.push({
        stack: blocks(
          cell.children,
          context,
          Math.max(20, (width / columns) * colSpan - 12),
        ),
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
      widths: Array.from({ length: columns }, () => {
        return "*";
      }),
      headerRows: cells[0]?.every((cell) => {
        return cell.tagName === "th";
      })
        ? 1
        : 0,
      body,
    },
    layout: "lightHorizontalLines",
    fontSize: 9,
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
        stack: content,
        style: node.tagName,
        headlineLevel: Number(node.tagName.slice(1)),
        // Per-message heading slugs can collide. Fragment links are not exported,
        // so do not register these unused IDs in the combined PDF.
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
          text,
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
