import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { SaxesParser } from "saxes";

import { safeSync } from "../utils";

const EMU_PER_POINT = 12_700;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;

function numberAttribute(
  tag: string,
  name: "x" | "y" | "cx" | "rot",
): number | undefined {
  const value = [...tag.matchAll(/\b(x|y|cx|rot)="(-?\d+)"/gu)].find(
    (match) => {
      return match[1] === name;
    },
  )?.[2];
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function textAnchor(shape: string): number | undefined {
  const body = /<a:bodyPr\b[^>]*>/u.exec(shape)?.[0];
  if (
    !body?.includes('wrap="none"') ||
    /\bvert="(?!horz")[^"]+"/u.test(body) ||
    /<p:style\b|<a:lstStyle\b[^>]*(?<!\/)>(?:\s*<(?!\/))/u.test(shape)
  ) {
    return undefined;
  }
  const alignments = [...shape.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/gu)].map(
    (match) => {
      const properties = /<a:pPr\b[^>]*>/u.exec(match[0])?.[0];
      return properties
        ? (/\balgn="([^"]+)"/u.exec(properties)?.[1] ?? "l")
        : "l";
    },
  );
  const alignment = alignments[0] ?? "l";
  if (
    !["l", "ctr", "r"].includes(alignment) ||
    alignments.some((value) => {
      return value !== alignment;
    }) ||
    /\brtl="(?:1|true)"/u.test(shape)
  ) {
    return undefined;
  }
  return alignment === "ctr" ? 0.5 : alignment === "r" ? 1 : 0;
}

function unpaintedProperties(shape: string): string | undefined {
  const properties = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/u.exec(shape)?.[1];
  if (!properties || !/<a:prstGeom\b[^>]*\bprst="rect"/u.test(properties)) {
    return undefined;
  }
  const line = /<a:ln\b[^>]*(?:\/>|>[\s\S]*?<\/a:ln>)/u.exec(properties)?.[0];
  const paint = line ? properties.replace(line, "") : properties;
  if (
    !paint.includes("<a:noFill/>") ||
    /<a:(?:solidFill|gradFill|blipFill|pattFill|grpFill|effectDag)\b/u.test(
      paint,
    ) ||
    /<a:effectLst\b[^>]*(?<!\/)>(?:\s*<(?!\/))/u.test(paint) ||
    (line !== undefined &&
      !line.includes("<a:noFill/>") &&
      !/^<a:ln(?:\s*\/>|>\s*<\/a:ln>)$/u.test(line) &&
      !line.includes('<a:alpha val="0"'))
  ) {
    return undefined;
  }
  return properties;
}

function fontSize(shape: string): number | undefined {
  const sizes = [
    ...shape.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/gu),
  ].map((match) => {
    return Number(match[1]);
  });
  const size = sizes.reduce((maximum, value) => {
    return Math.max(maximum, value);
  }, 0);
  return Number.isSafeInteger(size) && size > 0 && size <= 400_000
    ? size
    : undefined;
}

function widenTextFrame(
  transform: string,
  size: number,
  anchor: number,
): string {
  if (/\bflip[HV]="(?:1|true)"/u.test(transform)) {
    return transform;
  }
  const offset = /<a:off\b[^>]*\/>/u.exec(transform)?.[0];
  const extent = /<a:ext\b[^>]*\/>/u.exec(transform)?.[0];
  if (!offset || !extent) {
    return transform;
  }
  const x = numberAttribute(offset, "x");
  const y = numberAttribute(offset, "y");
  const width = numberAttribute(extent, "cx");
  if (x === undefined || y === undefined || width === undefined || width <= 0) {
    return transform;
  }
  // A fixed one-point allowance still reflows large Arial/Geist headings in
  // Google's importer. One tenth of an em preserves the measured line in the
  // real import fixture without scaling its font or changing explicit breaks.
  const extra = Math.max(
    EMU_PER_POINT,
    Math.ceil((size * EMU_PER_POINT) / 1000),
  );
  if (!Number.isSafeInteger(width + extra)) {
    return transform;
  }
  const rotation =
    (((numberAttribute(transform, "rot") ?? 0) / 60_000) * Math.PI) / 180;
  const nextX = Math.round(
    x + (Math.cos(rotation) * (0.5 - anchor) - 0.5) * extra,
  );
  const nextY = Math.round(y + Math.sin(rotation) * (0.5 - anchor) * extra);
  return transform
    .replace(
      offset,
      offset
        .replace(/\bx="[^"]+"/u, `x="${nextX}"`)
        .replace(/\by="[^"]+"/u, `y="${nextY}"`),
    )
    .replace(extent, extent.replace(/\bcx="[^"]+"/u, `cx="${width + extra}"`));
}

/** Google reflows wrap="none" text even with noAutofit or spAutoFit.
 * Give transparent text boxes a small font-relative layout tolerance. Their
 * text anchor stays fixed; painted shapes and normal paragraph wrapping do not
 * change. This is import preparation, never a rewrite of the stored PPTX. */
function prepareTextBox(shape: string): string {
  const anchor = textAnchor(shape);
  const properties = unpaintedProperties(shape);
  const size = fontSize(shape);
  if (anchor === undefined || properties === undefined || size === undefined) {
    return shape;
  }
  const transform = /<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/u.exec(properties)?.[0];
  return transform
    ? shape.replace(transform, widenTextFrame(transform, size, anchor))
    : shape;
}

function prepareSlide(xml: string): string {
  const parser = new SaxesParser({ xmlns: true });
  const parts: string[] = [];
  let cursor = 0;
  let shape: { start: number; depth: number; nested: boolean } | undefined;
  const presentationNamespace =
    "http://schemas.openxmlformats.org/presentationml/2006/main";
  parser.on("opentag", (tag) => {
    if (tag.uri !== presentationNamespace || tag.local !== "sp") {
      return;
    }
    if (shape) {
      shape.depth += 1;
      shape.nested = true;
    } else {
      shape = {
        start: xml.lastIndexOf("<", parser.position - 1),
        depth: 1,
        nested: false,
      };
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.uri !== presentationNamespace || tag.local !== "sp" || !shape) {
      return;
    }
    shape.depth -= 1;
    if (shape.depth > 0) {
      return;
    }
    const source = xml.slice(shape.start, parser.position);
    parts.push(
      xml.slice(cursor, shape.start),
      shape.nested ? source : prepareTextBox(source),
    );
    cursor = parser.position;
    shape = undefined;
  });
  parser.write(xml).close();
  parts.push(xml.slice(cursor));
  return parts.join("");
}

export function prepareGoogleSlidesImport(
  file: Buffer,
):
  | { readonly ok: true; readonly file: Buffer }
  | { readonly ok: false; readonly message: string } {
  // Leave non-ZIP input to Drive's existing unsupported-format response.
  if (file.length < 2 || file.readUInt16LE(0) !== 0x4b_50) {
    return { ok: true, file };
  }
  const prepared = safeSync(() => {
    let expanded = 0;
    let count = 0;
    const entries = unzipSync(file, {
      filter(entry) {
        expanded += entry.originalSize;
        count += 1;
        if (expanded > MAX_EXPANDED_BYTES || count > MAX_ARCHIVE_ENTRIES) {
          throw new Error("Presentation archive exceeds inspection limits");
        }
        return true;
      },
    });
    let changed = false;
    for (const [name, bytes] of Object.entries(entries)) {
      if (!/^ppt\/slides\/slide\d+\.xml$/u.test(name)) {
        continue;
      }
      const xml = strFromU8(bytes);
      const next = prepareSlide(xml);
      if (next !== xml) {
        entries[name] = strToU8(next);
        changed = true;
      }
    }
    return changed ? Buffer.from(zipSync(entries)) : file;
  });
  if ("error" in prepared) {
    return {
      ok: false,
      message: "This presentation could not be prepared for Google Slides",
    };
  }
  return { ok: true, file: prepared.ok };
}
