import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Paragraph,
  Packer,
  type IParagraphOptions,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Element, Root, RootContent } from "hast";
import { visit } from "unist-util-visit";

import { i18n } from "../i18n/index.ts";
import { parseMessagePdfTree } from "./message-pdf/document.ts";
import type { PdfAssets, PdfRasterImage } from "./message-pdf/types.ts";

const MAX_IMAGE_WIDTH = 600;
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
}

type InlineRun = TextRun | ImageRun | ExternalHyperlink;

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

function imageRun(image: PdfRasterImage, alt: string): ImageRun {
  const scale = Math.min(1, MAX_IMAGE_WIDTH / image.width);
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
    ...(style.code ? { font: "Consolas", color: "344054", size: 20 } : {}),
  });
}

function imageInline(node: Element, assets: PdfAssets): InlineRun[] {
  const source = node.properties.src;
  const image =
    typeof source === "string" ? assets.images.get(source) : undefined;
  if (!image) {
    return [];
  }
  const alt =
    typeof node.properties.alt === "string" ? node.properties.alt : "";
  return [imageRun(image, alt)];
}

function mermaidInline(node: Element, assets: PdfAssets): InlineRun[] {
  const mermaid = node.data?.mermaid;
  if (!mermaid) {
    return [];
  }
  const image = assets.diagrams.get(mermaid.code);
  return image
    ? [imageRun(image, "Mermaid diagram")]
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
    return mermaidInline(node, assets);
  }
  if (node.tagName === "br") {
    return [new TextRun({ text: "\n" })];
  }
  if (node.tagName === "img") {
    return imageInline(node, assets);
  }
  const nextStyle: InlineStyle = {
    bold: style.bold || ["strong", "b", "th"].includes(node.tagName),
    italics: style.italics || ["em", "i"].includes(node.tagName),
    strike: style.strike || ["del", "s"].includes(node.tagName),
    code: style.code || node.tagName === "code",
  };
  const children = inlineChildren(node.children, baseUrl, assets, nextStyle);
  const link =
    node.tagName === "a"
      ? safeDocxLink(node.properties.href, baseUrl)
      : undefined;
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

function tableRows(
  node: Element,
  baseUrl: string,
  assets: PdfAssets,
): TableRow[] {
  const rows: Element[] = [];
  const collectRows = (candidate: RootContent) => {
    if (candidate.type === "element") {
      if (candidate.tagName === "tr") {
        rows.push(candidate);
        return;
      }
      if (["thead", "tbody", "tfoot"].includes(candidate.tagName)) {
        for (const child of candidate.children) {
          collectRows(child);
        }
      }
    }
  };
  for (const child of node.children) {
    collectRows(child);
  }
  return rows.map((row, rowIndex) => {
    const cells = row.children.filter((child): child is Element => {
      return child.type === "element" && ["td", "th"].includes(child.tagName);
    });
    return new TableRow({
      tableHeader: rowIndex === 0,
      children: cells.map((cell) => {
        const heading = cell.tagName === "th";
        return new TableCell({
          width: {
            size: Math.floor(9000 / Math.max(cells.length, 1)),
            type: WidthType.DXA,
          },
          children: [
            paragraph(
              inlineChildren(cell.children, baseUrl, assets, {
                bold: heading,
              }),
            ),
          ],
        });
      }),
    });
  });
}

function listBlocks(
  node: Element,
  baseUrl: string,
  assets: PdfAssets,
  depth = 0,
): Paragraph[] {
  const ordered = node.tagName === "ol";
  return node.children.flatMap((child, index) => {
    if (child.type !== "element" || child.tagName !== "li") {
      return [];
    }
    const nestedLists: Element[] = [];
    const inlineNodes = child.children.filter((entry) => {
      if (entry.type === "element" && ["ol", "ul"].includes(entry.tagName)) {
        nestedLists.push(entry);
        return false;
      }
      return true;
    });
    const contentNodes = inlineNodes.flatMap((entry) => {
      return entry.type === "element" && entry.tagName === "p"
        ? entry.children
        : [entry];
    });
    const marker = ordered ? `${index + 1}. ` : "• ";
    const current = paragraph(
      [
        new TextRun({ text: marker }),
        ...inlineChildren(contentNodes, baseUrl, assets),
      ],
      { indent: { left: 360 * (depth + 1) } },
    );
    return [
      current,
      ...nestedLists.flatMap((list) => {
        return listBlocks(list, baseUrl, assets, depth + 1);
      }),
    ];
  });
}

function blockquoteBlocks(
  node: Element,
  baseUrl: string,
  assets: PdfAssets,
): (Paragraph | Table)[] {
  return node.children.flatMap((child) => {
    if (child.type === "element" && child.tagName === "p") {
      return [
        paragraph(inlineChildren(child.children, baseUrl, assets), {
          indent: { left: 360 },
          border: {
            left: {
              color: "98A2B3",
              space: 8,
              style: BorderStyle.SINGLE,
              size: 12,
            },
          },
        }),
      ];
    }
    return blockChildren([child], baseUrl, assets);
  });
}

function blockChildren(
  nodes: readonly RootContent[],
  baseUrl: string,
  assets: PdfAssets,
): (Paragraph | Table)[] {
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
          [
            new TextRun({
              text: textContent(node),
              font: "Consolas",
              color: "344054",
              size: 20,
            }),
          ],
          {
            shading: { fill: "F2F4F7" },
            indent: { left: 180, right: 180 },
            spacing: { before: 80, after: 160 },
          },
        ),
      ];
    }
    if (tag === "blockquote") {
      return blockquoteBlocks(node, baseUrl, assets);
    }
    if (tag === "ul" || tag === "ol") {
      return listBlocks(node, baseUrl, assets);
    }
    if (tag === "table") {
      const rows = tableRows(node, baseUrl, assets);
      return rows.length
        ? [
            new Table({
              rows,
              width: { size: "100%", type: WidthType.PERCENTAGE },
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: "D0D5DD" },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: "D0D5DD" },
                left: { style: BorderStyle.SINGLE, size: 1, color: "D0D5DD" },
                right: { style: BorderStyle.SINGLE, size: 1, color: "D0D5DD" },
                insideHorizontal: {
                  style: BorderStyle.SINGLE,
                  size: 1,
                  color: "D0D5DD",
                },
                insideVertical: {
                  style: BorderStyle.SINGLE,
                  size: 1,
                  color: "D0D5DD",
                },
              },
            }),
          ]
        : [];
    }
    if (tag === "hr") {
      return [paragraph([])];
    }
    if (["div", "section", "article", "figure", "figcaption"].includes(tag)) {
      return blockChildren(node.children, baseUrl, assets);
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
  visit(tree, "element", (node) => {
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
  return new Document({
    creator: "Okou",
    title: i18n.t(($) => {
      return $.artifacts.actions.markdownExportTitle;
    }),
    sections: [
      {
        properties: {
          page: {
            margin: { top: 900, right: 900, bottom: 900, left: 900 },
          },
        },
        children: blockChildren(tree.children, baseUrl, assets),
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
