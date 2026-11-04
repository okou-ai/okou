import { strToU8, zipSync } from "fflate";
import type { Element, Nodes } from "hast";

export const TABLE_WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function cellText(node: Nodes): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type !== "element") {
    return "";
  }
  if (node.data?.math) {
    return node.data.math.raw;
  }
  if (node.tagName === "br") {
    return "\n";
  }
  if (node.tagName === "img") {
    return typeof node.properties.alt === "string" ? node.properties.alt : "";
  }
  const text = node.children.map(cellText).join("");
  const href = node.properties.href;
  // Keep source URLs in the exported data, including multiple links per cell.
  if (
    node.tagName === "a" &&
    typeof href === "string" &&
    /^(https?:|mailto:)/iu.test(href) &&
    text !== href
  ) {
    return `${text} (${href})`;
  }
  return text;
}

/** Snapshot the same parsed table used by the renderer, excluding neighboring tables. */
export function readMarkdownTable(table: Element): string[][] {
  return table.children.flatMap((child) => {
    if (child.type !== "element") {
      return [];
    }
    if (child.tagName === "tr") {
      return [
        child.children
          .filter((cell) => {
            return (
              cell.type === "element" &&
              (cell.tagName === "td" || cell.tagName === "th")
            );
          })
          .map((cell) => {
            return cellText(cell).trim();
          }),
      ];
    }
    return ["thead", "tbody", "tfoot"].includes(child.tagName)
      ? readMarkdownTable(child)
      : [];
  });
}

function xml(value: string): string {
  const text = value.replace(/[\p{Cc}\p{Cs}\uFFFE\uFFFF]/gu, (character) => {
    return "\t\n\r".includes(character) ? character : "";
  });
  return new XMLSerializer().serializeToString(document.createTextNode(text));
}

function columnName(index: number): string {
  let name = "";
  for (
    let column = index + 1;
    column > 0;
    column = Math.floor((column - 1) / 26)
  ) {
    name = String.fromCharCode(65 + ((column - 1) % 26)) + name;
  }
  return name;
}

/** A genuine XLSX; literal strings preserve IDs, leading zeros and formula-like text. */
export function writeTableWorkbook(rows: readonly (readonly string[])[]): Blob {
  const data = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${reference}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const columns = Array.from({ length: rows[0]?.length ?? 0 }, (_, index) => {
    return `<col min="${index + 1}" max="${index + 1}" width="28" customWidth="1"/>`;
  }).join("");
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Table" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${data}</sheetData></worksheet>`,
  };
  const archive = zipSync(
    Object.fromEntries(
      Object.entries(parts).map(([path, content]) => {
        return [
          path,
          strToU8(`<?xml version="1.0" encoding="UTF-8"?>${content}`),
        ];
      }),
    ),
  );
  return new Blob([new Uint8Array(archive)], {
    type: TABLE_WORKBOOK_CONTENT_TYPE,
  });
}
