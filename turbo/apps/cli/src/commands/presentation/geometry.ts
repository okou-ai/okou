import { crc32, deflateRawSync, inflateRawSync } from "zlib";

import type { Layout } from "./layout";

/** The renderer writes ordinary, non-encrypted ZIP entries. Reject other methods. */
export function pptxEntries(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Not a PPTX ZIP container");
  const entries = new Map<string, Buffer>();
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid PPTX central directory");
    }
    const method = archive.readUInt16LE(offset + 10);
    if (method !== 0 && method !== 8) {
      throw new Error(
        `Unsupported PPTX compression method ${method.toString()}`,
      );
    }
    const size = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const start =
      local +
      30 +
      archive.readUInt16LE(local + 26) +
      archive.readUInt16LE(local + 28);
    const bytes = archive.subarray(start, start + size);
    entries.set(
      name,
      method === 8 ? inflateRawSync(bytes) : Buffer.from(bytes),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function pack(entries: ReadonlyMap<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const encoded = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(encoded.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, encoded);
    offset += header.length + encoded.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

function attribute(xml: string, name: string): number {
  const match = [...xml.matchAll(/\b(x|y|cx|cy)="([^"]+)"/gu)].find((entry) => {
    return entry[1] === name;
  });
  if (match === undefined)
    throw new Error(`Missing PPTX geometry attribute ${name}`);
  const value = Number(match[2]);
  if (!Number.isFinite(value))
    throw new Error(`Invalid PPTX geometry attribute ${name}`);
  return value;
}

function xmlValue(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;");
}

/** Fixed boxes and per-line text are one layout contract, not an autofit heuristic. */
export function applyGeometry(
  deck: Buffer,
  layout: Layout,
  width: number,
  height: number,
): Buffer {
  const entries = pptxEntries(deck);
  for (let pageIndex = 0; pageIndex < layout.pages.length; pageIndex += 1) {
    const page = layout.pages[pageIndex];
    if (page === undefined)
      throw new Error("Missing measured presentation page");
    const name = `ppt/slides/slide${(pageIndex + 1).toString()}.xml`;
    const original = entries.get(name);
    if (original === undefined)
      throw new Error(`Missing rendered page ${name}`);
    const scale = Math.min(
      (width * 914_400) / page.width,
      (height * 914_400) / page.height,
    );
    const offsetX = (width * 914_400 - page.width * scale) / 2;
    const offsetY = (height * 914_400 - page.height * scale) / 2;
    let xml = original
      .toString("utf8")
      .replace(/<a:spAutoFit\s*\/>/gu, "<a:noAutofit/>");
    xml = xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/gu, (shape) => {
      const transform = /<a:xfrm\b[\s\S]*?<\/a:xfrm>/u.exec(shape)?.[0];
      if (transform === undefined || !shape.includes("<a:t>")) return shape;
      const off = /<a:off\b[^>]*\/?>/u.exec(transform)?.[0];
      if (off === undefined) return shape;
      const x = attribute(off, "x");
      const y = attribute(off, "y");
      const box = page.textBoxes.find((box) => {
        return (
          Math.abs(x - offsetX - box.x * scale) < 3 &&
          Math.abs(y - offsetY - box.y * scale) < 3
        );
      });
      if (box === undefined) return shape;
      let fixed = shape.replace(
        /(<a:bodyPr\b[^>]*?)\s+wrap="[^"]*"/gu,
        '$1 wrap="none"',
      );
      if (box.eastAsianFont)
        fixed = fixed.replace(
          /<a:ea typeface="[^"]*"/gu,
          `<a:ea typeface="${xmlValue(box.eastAsianFont)}"`,
        );
      if (box.complexFont)
        fixed = fixed.replace(
          /<a:cs typeface="[^"]*"/gu,
          `<a:cs typeface="${xmlValue(box.complexFont)}"`,
        );
      if (box.strike)
        fixed = fixed.replace(
          /<a:rPr\b([^>]*?)>/gu,
          '<a:rPr$1 strike="sngStrike">',
        );
      if (box.underlineColor) {
        const line =
          box.underlineWidth > 0
            ? `<a:uLn w="${Math.round(box.underlineWidth * scale).toString()}"><a:solidFill><a:srgbClr val="${box.underlineColor}"/></a:solidFill></a:uLn>`
            : "";
        const underline = `${line}<a:uFill><a:solidFill><a:srgbClr val="${box.underlineColor}"/></a:solidFill></a:uFill>`;
        fixed = fixed.replace(/<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/gu, (run) => {
          const anchor =
            /<a:(?:latin|ea|cs|sym|hlinkClick|hlinkMouseOver|extLst)\b/u;
          return anchor.test(run)
            ? run.replace(anchor, `${underline}$&`)
            : run.replace("</a:rPr>", `${underline}</a:rPr>`);
        });
      }
      return fixed;
    });
    let tableIndex = 0;
    xml = xml.replace(
      /<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/gu,
      (frame) => {
        if (!frame.includes("<a:tbl>")) return frame;
        const table = page.tables[tableIndex++];
        if (table === undefined)
          throw new Error("Rendered table has no browser measurement");
        const rows = [...frame.matchAll(/<a:tr\b/gu)];
        if (rows.length !== table.rows.length)
          throw new Error(
            "Rendered table row count disagrees with browser geometry",
          );
        const ext = /<a:ext\b[^>]*\/?>/u.exec(frame)?.[0];
        if (ext === undefined)
          throw new Error("Rendered table has no frame extent");
        const tableScale = attribute(ext, "cx") / table.w;
        const heights = table.rows.map((value) => {
          return Math.round(value * tableScale);
        });
        let rowIndex = 0;
        let fixed = frame.replace(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/gu, (row) => {
          const height = heights[rowIndex];
          const fills = table.fills[rowIndex++];
          if (height === undefined)
            throw new Error("Missing measured table row height");
          let cellIndex = 0;
          return row
            .replace(
              /(<a:tr\b[^>]*?)\bh="[^"]*"/u,
              `$1h="${height.toString()}"`,
            )
            .replace(/<a:tc\b[\s\S]*?<\/a:tc>/gu, (cell) => {
              const fill = fills?.[cellIndex++];
              if (!fill) return cell;
              return cell.replace(
                /<a:tcPr\b([^>]*)>([\s\S]*?)<\/a:tcPr>/u,
                (_match: string, attributes: string, properties: string) => {
                  // Replace cell fill without deleting paints inside border lines.
                  const borders: string[] = [];
                  const clean = properties
                    .replace(
                      /<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[\s\S]*?<\/a:ln(?:L|R|T|B|TlToBr|BlToTr)>/gu,
                      (border) => {
                        borders.push(border);
                        return `__border${(borders.length - 1).toString()}__`;
                      },
                    )
                    .replace(
                      /<a:(?:solidFill|gradFill|blipFill|pattFill|grpFill)\b[\s\S]*?<\/a:(?:solidFill|gradFill|blipFill|pattFill|grpFill)>|<a:noFill\s*\/>/gu,
                      "",
                    )
                    .replace(
                      /__border(\d+)__/gu,
                      (_match: string, index: string) => {
                        const border = borders[Number(index)];
                        if (border === undefined)
                          throw new Error("Missing preserved table border");
                        return border;
                      },
                    );
                  return `<a:tcPr${attributes}>${clean}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr>`;
                },
              );
            });
        });
        const height = heights.reduce((total, value) => {
          return total + value;
        }, 0);
        fixed = fixed.replace(
          ext,
          ext.replace(/\bcy="[^"]*"/u, `cy="${height.toString()}"`),
        );
        return fixed;
      },
    );
    if (tableIndex !== page.tables.length)
      throw new Error("Measured table was omitted by the renderer");
    entries.set(name, Buffer.from(xml, "utf8"));
  }
  return pack(entries);
}
