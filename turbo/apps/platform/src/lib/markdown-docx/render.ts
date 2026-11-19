import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { convert } from "pandoc-wasm";

import type {
  DocxWorkerRequest,
  PdfRasterImage,
} from "../message-pdf/types.ts";
import referenceUrl from "./reference.docx?url&inline";

const MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OUTPUT = "output.docx";
const REFERENCE = "reference.docx";
const DOCUMENT_XML = "word/document.xml";
const WIDE_TABLE_COLUMNS = 7;
const A4_WIDTH = 11_906;
const A4_HEIGHT = 16_838;
const TOTAL_HORIZONTAL_MARGINS = 1800;
const EAST_ASIAN_CHARACTER =
  /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff60]/u;

type PandocValue =
  string | number | boolean | null | PandocValue[] | PandocObject;
interface PandocObject {
  [key: string]: PandocValue;
}

interface Layout {
  readonly assets: DocxWorkerRequest["assets"];
  readonly baseUrl: string;
  readonly files: Record<string, Blob>;
  readonly tables: PandocValue[][];
  imageCount: number;
}

function array(value: PandocValue): PandocValue[] {
  if (!Array.isArray(value)) {
    throw new Error("Unexpected Pandoc document structure");
  }
  return value;
}

function text(value: PandocValue): string {
  if (Array.isArray(value)) {
    return value.map(text).join("");
  }
  if (value !== null && typeof value === "object") {
    if (value.t === "Str" || value.t === "Code") {
      const content = value.t === "Code" ? array(value.c)[1] : value.c;
      return typeof content === "string" ? content : "";
    }
    return value.t === "Space" ? " " : text(value.c ?? null);
  }
  return "";
}

function dataUrlBytes(url: string): Uint8Array<ArrayBuffer> {
  const data = atob(url.slice(url.indexOf(",") + 1));
  return Uint8Array.from(data, (character) => {
    return character.charCodeAt(0);
  });
}

function addImage(image: PdfRasterImage, layout: Layout): string {
  const name = `image-${++layout.imageCount}.png`;
  const bytes = dataUrlBytes(image.dataUrl);
  layout.files[name] = new Blob([bytes], { type: "image/png" });
  return name;
}

function setImageWidth(attributes: PandocValue, image: PdfRasterImage): void {
  const attrs = array(attributes);
  const values = array(attrs[2]).filter((entry) => {
    return array(entry)[0] !== "width" && array(entry)[0] !== "height";
  });
  values.push(["width", `${Math.min(450, image.width * 0.75)}pt`]);
  attrs[2] = values;
}

function assetImage(layout: Layout, target: string): PdfRasterImage {
  const direct = layout.assets.images.get(target);
  if (direct) {
    return direct;
  }
  const url = URL.parse(target, layout.baseUrl);
  for (const [source, image] of layout.assets.images) {
    if (url && URL.parse(source, layout.baseUrl)?.href === url.href) {
      return image;
    }
  }
  throw new Error("DOCX image asset is missing");
}

function rewriteLink(
  t: "Link" | "Image",
  c: PandocValue,
  layout: Layout,
): PandocValue {
  const [attrs, label, destination] = array(c);
  const target = array(destination)[0];
  if (typeof target !== "string") {
    throw new Error("Unexpected Pandoc link destination");
  }
  if (t === "Image") {
    const image = assetImage(layout, target);
    setImageWidth(attrs, image);
    return {
      t,
      c: [attrs, rewrite(label, layout), [addImage(image, layout), ""]],
    };
  }
  const href = URL.parse(target, layout.baseUrl);
  const children = rewrite(label, layout);
  if (target.startsWith("#")) {
    return { t, c: [attrs, children, destination] };
  }
  if (
    target &&
    href &&
    ["http:", "https:", "mailto:", "tel:"].includes(href.protocol) &&
    !href.username &&
    !href.password
  ) {
    return { t, c: [attrs, children, [href.href, array(destination)[1]]] };
  }
  return { t: "Span", c: [attrs, children] };
}

function rewrite(value: PandocValue, layout: Layout): PandocValue {
  if (Array.isArray(value)) {
    return value.map((child) => {
      return rewrite(child, layout);
    });
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const { t, c } = value;
  if (t === "Link" || t === "Image") {
    return rewriteLink(t, c, layout);
  }
  if (t === "CodeBlock") {
    const [attrs, code] = array(c);
    if (
      typeof code === "string" &&
      array(array(attrs)[1]).includes("mermaid")
    ) {
      for (const [source, image] of layout.assets.diagrams) {
        if (source.trimEnd() === code.trimEnd()) {
          const attributes: PandocValue = ["", [], []];
          setImageWidth(attributes, image);
          return {
            t: "Para",
            c: [
              {
                t: "Image",
                c: [
                  attributes,
                  [{ t: "Str", c: "Mermaid diagram" }],
                  [addImage(image, layout), ""],
                ],
              },
            ],
          };
        }
      }
      // Only closed fences prepared by the shared asset renderer become diagrams.
    }
  }
  if (c === undefined) {
    return value;
  }
  const rewritten = rewrite(c, layout);
  if (t === "Table") {
    layout.tables.push(array(rewritten));
  }
  return { ...value, c: rewritten };
}

function rows(table: PandocValue[]): PandocValue[] {
  // Pandoc stores the header, bodies and footer after the column specs.
  const head = array(table[3]);
  const bodies = array(table[4]);
  const foot = array(table[5]);
  return [
    ...array(head[1]),
    ...bodies.flatMap((body) => {
      const parts = array(body);
      return [...array(parts[2]), ...array(parts[3])];
    }),
    ...array(foot[1]),
  ];
}

function sizeTable(table: PandocValue[], pageWidth: number): void {
  const specs = array(table[2]);
  const weights = specs.map(() => {
    return 1;
  });
  for (const row of rows(table)) {
    let column = 0;
    for (const cell of array(array(row)[1])) {
      const parts = array(cell);
      const span = parts[3];
      const blocks = parts[4];
      if (typeof span !== "number" || column + span > weights.length) {
        throw new Error("Unexpected Pandoc table span");
      }
      const units = Array.from(text(blocks).trim().slice(0, 80)).reduce(
        (sum, character) => {
          return sum + (EAST_ASIAN_CHARACTER.test(character) ? 2 : 1);
        },
        0,
      );
      for (let offset = 0; offset < span; offset++) {
        const index = column + offset;
        weights[index] = Math.max(weights[index], Math.min(units / span, 26));
      }
      column += span;
    }
  }
  const total = weights.reduce((sum, weight) => {
    return sum + weight;
  }, 0);
  const minimum = Math.floor(Math.min(850, pageWidth / (specs.length * 2)));
  const remaining = pageWidth - minimum * specs.length;
  table[2] = specs.map((spec, index) => {
    const width = (minimum + (remaining * weights[index]) / total) / pageWidth;
    return [array(spec)[0], { t: "ColWidth", c: width }];
  });
}

function sizedReference(
  bytes: Uint8Array<ArrayBuffer>,
  landscape: boolean,
): Blob {
  if (!landscape) {
    return new Blob([bytes]);
  }
  const archive = unzipSync(bytes);
  const xml = strFromU8(archive[DOCUMENT_XML]).replace(
    /<w:pgSz\b[^>]*\/>/u,
    `<w:pgSz w:w="${A4_HEIGHT}" w:h="${A4_WIDTH}" w:orient="landscape"/>`,
  );
  archive[DOCUMENT_XML] = strToU8(xml);
  return new Blob([zipSync(archive)]);
}

async function finish(blob: Blob, tableWidth?: number): Promise<Blob> {
  if (tableWidth === undefined) {
    return new Blob([blob], { type: MIME });
  }
  const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const xml = strFromU8(archive[DOCUMENT_XML])
    // Pandoc writes grid widths relative to its own baseline page width.
    .replace(/<w:tblGrid>.*?<\/w:tblGrid>/gu, (grid) => {
      const total = [...grid.matchAll(/w:w="(\d+)"/gu)].reduce((sum, match) => {
        return sum + Number(match[1]);
      }, 0);
      if (!total) {
        return grid;
      }
      let offset = 0;
      return grid.replace(/w:w="(\d+)"/gu, (_match, initial: string) => {
        const previous = Math.round((offset * tableWidth) / total);
        offset += Number(initial);
        const width = Math.round((offset * tableWidth) / total) - previous;
        return `w:w="${width}"`;
      });
    })
    .replace(
      /<w:tr>(<w:trPr>)?/gu,
      (_match, properties: string | undefined) => {
        return properties
          ? "<w:tr><w:trPr><w:cantSplit/>"
          : "<w:tr><w:trPr><w:cantSplit/></w:trPr>";
      },
    );
  archive[DOCUMENT_XML] = strToU8(xml);
  return new Blob([zipSync(archive)], { type: MIME });
}

export async function renderMarkdownDocx({
  source,
  assets,
  baseUrl,
}: DocxWorkerRequest): Promise<Blob> {
  const parsed = await convert(
    {
      from: "markdown+tex_math_single_backslash+task_lists-implicit_figures-raw_attribute",
      to: "json",
    },
    source,
    {},
  );
  // Pandoc's own JSON writer supplies this intermediate structure.
  const { blocks, ...metadata } = JSON.parse(parsed.stdout) as PandocObject;
  const layout: Layout = {
    assets,
    baseUrl,
    files: {},
    tables: [],
    imageCount: 0,
  };
  const content = rewrite(blocks, layout);
  const landscape = layout.tables.some((table) => {
    return array(table[2]).length >= WIDE_TABLE_COLUMNS;
  });
  const pageWidth =
    (landscape ? A4_HEIGHT : A4_WIDTH) - TOTAL_HORIZONTAL_MARGINS;
  for (const table of layout.tables) {
    sizeTable(table, pageWidth);
  }
  const reference = dataUrlBytes(referenceUrl);
  layout.files[REFERENCE] = sizedReference(reference, landscape);
  const result = await convert(
    {
      from: "json",
      to: "docx",
      "reference-doc": REFERENCE,
      "output-file": OUTPUT,
      "highlight-style": "none",
    },
    JSON.stringify({ ...metadata, blocks: content }),
    layout.files,
  );
  const output = result.files[OUTPUT];
  if (!output?.size) {
    throw new Error("Pandoc could not generate a DOCX file");
  }
  return finish(output, layout.tables.length ? pageWidth : undefined);
}
