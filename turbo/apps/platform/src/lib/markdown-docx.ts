import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  type INumberingOptions,
  LevelFormat,
  PageOrientation,
  Paragraph,
  Packer,
  type IParagraphOptions,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from "docx";
import type { Element, Root, RootContent } from "hast";
import { visit } from "unist-util-visit";

import { i18n } from "../i18n/index.ts";
import { parseMessagePdfTree } from "./message-pdf/document.ts";
import type { PdfAssets, PdfRasterImage } from "./message-pdf/types.ts";

const BLACK = "000000";
const MAX_IMAGE_WIDTH = 600;
const A4_WIDTH = 11_906;
const A4_HEIGHT = 16_838;
const PAGE_MARGIN = 900;
const WIDE_TABLE_COLUMNS = 7;
const TABLE_CELL_HORIZONTAL_PADDING = 95;
const TWIPS_PER_PIXEL = 15;
const EAST_ASIAN_CHARACTER =
  /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff60]/u;
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

interface InlineStyle {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
  readonly hyperlink?: boolean;
  readonly maxImageWidth?: number;
}

type InlineRun = TextRun | ImageRun | ExternalHyperlink;

interface DocumentLayout {
  readonly baseUrl: string;
  readonly assets: PdfAssets;
  readonly tableWidth: number;
  readonly tables: ReadonlyMap<Element, readonly Element[][]>;
  readonly numbering: INumberingOptions["config"][number][];
}

function textContent(node: RootContent): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type !== "element" || node.data?.copyCode !== undefined) {
    return "";
  }
  return node.children.map(textContent).join("");
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) {
    throw new Error("DOCX image data is invalid");
  }
  const binary = atob(dataUrl.slice(comma + 1));
  return Uint8Array.from(binary, (character) => {
    return character.charCodeAt(0);
  });
}

function imageRun(
  image: PdfRasterImage,
  alt: string,
  maxWidth = MAX_IMAGE_WIDTH,
): ImageRun {
  const scale = Math.min(1, maxWidth / image.width);
  return new ImageRun({
    type: "png",
    data: dataUrlBytes(image.dataUrl),
    transformation: {
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale)),
    },
    altText: {
      description:
        alt ||
        i18n.t(($) => {
          return $.artifacts.actions.markdownImageAlt;
        }),
    },
  });
}

function textRun(value: string, style: InlineStyle): TextRun {
  return new TextRun({
    text: value,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code ? { font: "Consolas", size: 20 } : {}),
    ...(style.hyperlink ? { style: "Hyperlink" } : {}),
  });
}

function imageInline(
  node: Element,
  assets: PdfAssets,
  maxImageWidth: number | undefined,
): InlineRun[] {
  const source = node.properties.src;
  const image =
    typeof source === "string" ? assets.images.get(source) : undefined;
  if (!image) {
    return [];
  }
  const alt =
    typeof node.properties.alt === "string" ? node.properties.alt : "";
  return [imageRun(image, alt, maxImageWidth)];
}

function mermaidInline(
  node: Element,
  assets: PdfAssets,
  maxImageWidth: number | undefined,
): InlineRun[] {
  const mermaid = node.data?.mermaid;
  if (!mermaid) {
    return [];
  }
  const image = assets.diagrams.get(mermaid.code);
  return image
    ? [imageRun(image, "Mermaid diagram", maxImageWidth)]
    : [new TextRun({ text: "[Diagram unavailable]", italics: true })];
}

function safeDocxLink(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value, baseUrl)) {
    return undefined;
  }
  const target = new URL(value, baseUrl);
  return ["https:", "http:", "mailto:", "tel:"].includes(target.protocol) &&
    !target.username &&
    !target.password
    ? target.href
    : undefined;
}

function inlineElement(
  node: Element,
  baseUrl: string,
  assets: PdfAssets,
  style: InlineStyle,
): InlineRun[] {
  if (node.data?.mermaid) {
    return mermaidInline(node, assets, style.maxImageWidth);
  }
  if (node.tagName === "br") {
    return [new TextRun({ break: 1 })];
  }
  if (node.tagName === "img") {
    return imageInline(node, assets, style.maxImageWidth);
  }
  const nextStyle: InlineStyle = {
    ...style,
    bold: style.bold || ["strong", "b", "th"].includes(node.tagName),
    italics: style.italics || ["em", "i"].includes(node.tagName),
    strike: style.strike || ["del", "s"].includes(node.tagName),
    code: style.code || node.tagName === "code",
  };
  const link =
    node.tagName === "a"
      ? safeDocxLink(node.properties.href, baseUrl)
      : undefined;
  const children = inlineChildren(node.children, baseUrl, assets, {
    ...nextStyle,
    hyperlink: nextStyle.hyperlink || link !== undefined,
  });
  return link ? [new ExternalHyperlink({ children, link })] : children;
}

function inlineChildren(
  nodes: readonly RootContent[],
  baseUrl: string,
  assets: PdfAssets,
  style: InlineStyle = {},
): InlineRun[] {
  return nodes.flatMap((node) => {
    if (node.type === "text") {
      return node.value ? [textRun(node.value, style)] : [];
    }
    return node.type === "element"
      ? inlineElement(node, baseUrl, assets, style)
      : [];
  });
}

function paragraph(
  children: InlineRun[],
  options: Omit<IParagraphOptions, "children"> = {},
): Paragraph {
  return new Paragraph({
    ...options,
    children,
    spacing: options.spacing ?? { after: 140 },
  });
}

function tableCells(node: Element): Element[][] {
  return node.children.flatMap((child) => {
    if (child.type !== "element") {
      return [];
    }
    if (child.tagName === "tr") {
      const cells = child.children.filter((entry): entry is Element => {
        return entry.type === "element" && ["td", "th"].includes(entry.tagName);
      });
      return cells.length > 0 ? [cells] : [];
    }
    return ["thead", "tbody", "tfoot"].includes(child.tagName)
      ? tableCells(child)
      : [];
  });
}

function tableColumnCount(rows: readonly Element[][]): number {
  return rows.reduce((count, row) => {
    return Math.max(count, row.length);
  }, 0);
}

function tableColumnWidths(
  rows: readonly Element[][],
  tableWidth: number,
): number[] {
  const columns = tableColumnCount(rows);
  const minimum = Math.floor(Math.min(850, tableWidth / (columns * 2)));
  const weights = Array.from({ length: columns }, () => {
    return 1;
  });
  for (const row of rows) {
    for (const [column, cell] of row.entries()) {
      const characters = Array.from(textContent(cell).trim().slice(0, 80));
      const width = characters.reduce((total, character) => {
        return total + (EAST_ASIAN_CHARACTER.test(character) ? 2 : 1);
      }, 0);
      weights[column] = Math.max(weights[column], Math.min(width, 26));
    }
  }
  const total = weights.reduce((sum, weight) => {
    return sum + weight;
  }, 0);
  const extra = tableWidth - minimum * columns;
  let allocated = 0;
  let cumulativeWeight = 0;
  return weights.map((weight) => {
    cumulativeWeight += weight;
    const next = Math.round((cumulativeWeight * extra) / total);
    const width = minimum + next - allocated;
    allocated = next;
    return width;
  });
}

function tableRows(
  rows: readonly Element[][],
  columnWidths: readonly number[],
  { baseUrl, assets }: DocumentLayout,
): TableRow[] {
  return rows.map((cells, rowIndex) => {
    return new TableRow({
      tableHeader:
        rowIndex === 0 &&
        cells.every((cell) => {
          return cell.tagName === "th";
        }),
      cantSplit: true,
      children: cells.map((cell, column) => {
        const width = columnWidths[column];
        return new TableCell({
          width: { size: width, type: WidthType.DXA },
          children: [
            paragraph(
              inlineChildren(cell.children, baseUrl, assets, {
                bold: cell.tagName === "th",
                maxImageWidth: Math.max(
                  1,
                  Math.floor(
                    (width - TABLE_CELL_HORIZONTAL_PADDING * 2) /
                      TWIPS_PER_PIXEL,
                  ),
                ),
              }),
              { spacing: { after: 0 } },
            ),
          ],
        });
      }),
    });
  });
}

function listBlocks(
  node: Element,
  layout: DocumentLayout,
  depth = 0,
): Paragraph[] {
  const ordered = node.tagName === "ol";
  const start =
    typeof node.properties.start === "number" ? node.properties.start : 1;
  const reference = `markdown-list-${layout.numbering.length}`;
  layout.numbering.push({
    reference,
    levels: [
      {
        level: 0,
        format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
        text: ordered ? "%1." : "•",
        start,
        style: {
          paragraph: { indent: { left: 360 * (depth + 1), hanging: 360 } },
        },
      },
    ],
  });
  return node.children.flatMap((child) => {
    if (child.type !== "element" || child.tagName !== "li") {
      return [];
    }
    const paragraphs: Paragraph[] = [];
    let pending: RootContent[] = [];
    const flush = () => {
      if (paragraphs.length > 0 && pending.length === 0) {
        return;
      }
      const options =
        paragraphs.length === 0
          ? { numbering: { reference, level: 0 } }
          : { indent: { left: 360 * (depth + 1) } };
      paragraphs.push(
        paragraph(
          inlineChildren(pending, layout.baseUrl, layout.assets),
          options,
        ),
      );
      pending = [];
    };
    for (const entry of child.children) {
      if (entry.type === "element" && ["ol", "ul"].includes(entry.tagName)) {
        flush();
        paragraphs.push(...listBlocks(entry, layout, depth + 1));
      } else if (entry.type === "element" && entry.tagName === "p") {
        pending.push(...entry.children);
        flush();
      } else if (
        entry.type !== "text" ||
        entry.value.trim() ||
        pending.length > 0
      ) {
        pending.push(entry);
      }
    }
    flush();
    return paragraphs;
  });
}

function blockquoteBlocks(
  node: Element,
  layout: DocumentLayout,
): (Paragraph | Table)[] {
  return node.children.flatMap((child) => {
    if (child.type === "element" && child.tagName === "p") {
      return [
        paragraph(
          inlineChildren(child.children, layout.baseUrl, layout.assets),
          {
            indent: { left: 360 },
            border: {
              left: {
                color: BLACK,
                space: 8,
                style: BorderStyle.SINGLE,
                size: 12,
              },
            },
          },
        ),
      ];
    }
    return blockChildren([child], layout);
  });
}

function blockChildren(
  nodes: readonly RootContent[],
  layout: DocumentLayout,
): (Paragraph | Table)[] {
  const { baseUrl, assets } = layout;
  return nodes.flatMap((node) => {
    if (node.type !== "element") {
      return node.type === "text" && node.value.trim()
        ? [paragraph([new TextRun({ text: node.value })])]
        : [];
    }
    const tag = node.tagName;
    if (node.data?.mermaid) {
      const image = assets.diagrams.get(node.data.mermaid.code);
      return image
        ? [paragraph([imageRun(image, "Mermaid diagram")])]
        : [
            paragraph([
              new TextRun({ text: "[Diagram unavailable]", italics: true }),
            ]),
          ];
    }
    if (/^h[1-6]$/u.test(tag)) {
      const index = Number(tag.slice(1)) - 1;
      return [
        paragraph(inlineChildren(node.children, baseUrl, assets), {
          heading: HEADING_LEVELS[index] ?? HeadingLevel.HEADING_6,
          spacing: { before: index === 0 ? 220 : 160, after: 100 },
        }),
      ];
    }
    if (tag === "p") {
      return [paragraph(inlineChildren(node.children, baseUrl, assets))];
    }
    if (tag === "pre") {
      return [
        paragraph(
          textContent(node)
            .replace(/\n$/u, "")
            .split("\n")
            .map((line, index) => {
              return new TextRun({
                text: line,
                break: index === 0 ? 0 : 1,
                font: "Consolas",
                size: 20,
              });
            }),
          {
            indent: { left: 180, right: 180 },
            spacing: { before: 80, after: 160 },
          },
        ),
      ];
    }
    if (tag === "blockquote") {
      return blockquoteBlocks(node, layout);
    }
    if (tag === "ul" || tag === "ol") {
      return listBlocks(node, layout);
    }
    if (tag === "table") {
      const cells = layout.tables.get(node);
      if (!cells?.length) {
        return [];
      }
      const columnWidths = tableColumnWidths(cells, layout.tableWidth);
      const tableBorder = { style: BorderStyle.SINGLE, size: 1, color: BLACK };
      return [
        new Table({
          rows: tableRows(cells, columnWidths, layout),
          columnWidths,
          layout: TableLayoutType.FIXED,
          width: { size: layout.tableWidth, type: WidthType.DXA },
          margins: {
            top: 70,
            right: TABLE_CELL_HORIZONTAL_PADDING,
            bottom: 70,
            left: TABLE_CELL_HORIZONTAL_PADDING,
          },
          borders: {
            top: tableBorder,
            bottom: tableBorder,
            left: tableBorder,
            right: tableBorder,
            insideHorizontal: tableBorder,
            insideVertical: tableBorder,
          },
        }),
      ];
    }
    if (tag === "hr") {
      return [paragraph([])];
    }
    if (["div", "section", "article", "figure", "figcaption"].includes(tag)) {
      return blockChildren(node.children, layout);
    }
    return [paragraph(inlineChildren([node], baseUrl, assets))];
  });
}

export function buildMarkdownDocxDocument(
  source: string,
  assets: PdfAssets,
  baseUrl: string,
): Document {
  const tree: Root = parseMessagePdfTree(source);
  const nodes: Element[] = [];
  const tables = new Map<Element, Element[][]>();
  let landscape = false;
  visit(tree, "element", (node) => {
    if (node.tagName === "table") {
      const rows = tableCells(node);
      tables.set(node, rows);
      landscape ||= tableColumnCount(rows) >= WIDE_TABLE_COLUMNS;
    }
    if (node.tagName === "img" || node.data?.mermaid) {
      nodes.push(node);
    }
  });
  for (const node of nodes) {
    if (node.tagName === "img") {
      const src = node.properties.src;
      if (typeof src === "string" && !assets.images.has(src)) {
        throw new Error("DOCX image asset is missing");
      }
    } else if (
      node.data?.mermaid &&
      !assets.diagrams.has(node.data.mermaid.code)
    ) {
      throw new Error("DOCX diagram asset is missing");
    }
  }
  const layout: DocumentLayout = {
    baseUrl,
    assets,
    tables,
    tableWidth: (landscape ? A4_HEIGHT : A4_WIDTH) - PAGE_MARGIN * 2,
    numbering: [],
  };
  const children = blockChildren(tree.children, layout);
  return new Document({
    styles: {
      default: {
        document: { run: { color: BLACK, size: 22 } },
        heading1: { run: { color: BLACK, size: 32, bold: true } },
        heading2: { run: { color: BLACK, size: 26, bold: true } },
        heading3: { run: { color: BLACK, size: 24, bold: true } },
        heading4: {
          run: { color: BLACK, size: 22, bold: true, italics: true },
        },
        heading5: { run: { color: BLACK, size: 22, bold: true } },
        heading6: { run: { color: BLACK, size: 22, italics: true } },
        caption: { run: { color: BLACK, size: 18, italics: true } },
        hyperlink: {
          run: { color: BLACK, underline: { type: UnderlineType.SINGLE } },
        },
      },
    },
    numbering: { config: layout.numbering },
    creator: "Okou",
    title: i18n.t(($) => {
      return $.artifacts.actions.markdownExportTitle;
    }),
    sections: [
      {
        properties: {
          page: {
            size: {
              width: A4_WIDTH,
              height: A4_HEIGHT,
              orientation: landscape
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
            },
          },
        },
        children,
      },
    ],
  });
}

export async function generateMarkdownDocxBlob(
  source: string,
  assets: PdfAssets,
  baseUrl: string,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const document = buildMarkdownDocxDocument(source, assets, baseUrl);
  signal.throwIfAborted();
  const blob = await Packer.toBlob(document);
  signal.throwIfAborted();
  return blob;
}
