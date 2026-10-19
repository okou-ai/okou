import { read as readCompoundFile } from "cfb";
import { decodeXML, escapeUTF8 } from "entities";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  googleWorkspaceConversion,
  type GoogleWorkspaceTarget,
} from "@okouai/core/google-workspace-conversion";
import { safeSync } from "../utils";
import { prepareGoogleDocsFonts } from "./google-docs-import.service";

const MAX_CELL_CHARACTERS = 50_000;
const MAX_CELLS = 20_000_000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

class ImportSourceError extends Error {}

function invalidSource(message: string): never {
  throw new ImportSourceError(message);
}

function utf8(file: Uint8Array): string {
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(file);
  });
  if ("error" in decoded || decoded.ok.includes("\0")) {
    return invalidSource(
      "Use an unencrypted UTF-8 text file for this conversion",
    );
  }
  return decoded.ok;
}

function readQuotedField(
  text: string,
  start: number,
): { readonly value: string; readonly end: number } {
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (text[index + 1] !== '"') {
        return { value, end: index };
      }
      index += 1;
    }
    value += character;
    if (value.length > MAX_CELL_CHARACTERS) {
      invalidSource("A cell exceeds Google Sheets' 50,000 character limit");
    }
  }
  return invalidSource("This table contains an unclosed quoted field");
}

/** Parse quoted fields without guessing dates, numbers, formulas or delimiters. */
function delimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let closedQuote = false;
  let cells = 0;
  let serializedBytesBudget = 0;
  const finishField = () => {
    // Bound the expanded XML before allocating it, including cell/row markup
    // and the worst-case escaping of each UTF-16 code unit.
    serializedBytesBudget += 128 + field.length * 6;
    if (serializedBytesBudget > MAX_EXPANDED_BYTES) {
      invalidSource("This table is too large to prepare for conversion safely");
    }
    cells += 1;
    if (cells > MAX_CELLS || row.length >= 16_384) {
      invalidSource("This table exceeds the supported spreadsheet dimensions");
    }
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (rows.length >= 1_048_576) {
      invalidSource("This table exceeds the supported spreadsheet dimensions");
    }
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === delimiter) {
      finishField();
    } else if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
    } else if (character === '"' && field.length === 0 && !closedQuote) {
      const quoted = readQuotedField(text, index);
      field = quoted.value;
      index = quoted.end;
      closedQuote = true;
    } else if (closedQuote || character === '"') {
      invalidSource("This table contains invalid quoted fields");
    } else {
      field += character;
    }
    if (field.length > MAX_CELL_CHARACTERS) {
      invalidSource("A cell exceeds Google Sheets' 50,000 character limit");
    }
  }
  if (field.length > 0 || closedQuote || row.length > 0 || rows.length === 0) {
    finishRow();
  }
  const columns = rows.reduce((maximum, item) => {
    return Math.max(maximum, item.length);
  }, 0);
  if (rows.length * columns > MAX_CELLS) {
    invalidSource("This table exceeds Google Sheets' cell limit");
  }
  return rows;
}

function xmlText(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xff_fe ||
      code === 0xff_ff
    ) {
      invalidSource("This table contains unsupported control characters");
    }
  }
  return escapeUTF8(
    value.replace(/_x[\da-f]{4}_/giu, (match) => {
      return `_x005F_${match.slice(1)}`;
    }),
  ).replaceAll("\r", "&#13;");
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

/** Explicit inline strings stop the Google importer from coercing CSV fields. */
function textWorkbook(rows: readonly (readonly string[])[]): Buffer {
  const sheet = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, column) => {
          return `<c r="${columnName(column)}${String(rowIndex + 1)}" s="0" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
    })
    .join("");
  const entries = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml":
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
  };
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([name, xml]) => {
          return [name, strToU8(xml)];
        }),
      ),
    ),
  );
}

function checkOfficeSource(
  file: Buffer,
  extension: string,
  sourceMimeType: string,
): void {
  if (extension === "doc" || extension === "xls") {
    const compound = readCompoundFile(file, { type: "buffer" });
    const names = new Set(
      compound.FileIndex.map((entry) => {
        return entry.name;
      }),
    );
    const expected =
      extension === "doc" ? ["WordDocument"] : ["Workbook", "Book"];
    if (
      names.has("EncryptedPackage") ||
      !expected.some((name) => {
        return names.has(name);
      })
    ) {
      invalidSource(
        "The file is encrypted or does not match its document format",
      );
    }
    return;
  }
  let expandedBytes = 0;
  let archiveEntries = 0;
  const archive = unzipSync(file, {
    filter(entry) {
      expandedBytes += entry.originalSize;
      archiveEntries += 1;
      if (
        expandedBytes > MAX_EXPANDED_BYTES ||
        archiveEntries > MAX_ARCHIVE_ENTRIES
      ) {
        invalidSource("This document is too large to inspect safely");
      }
      return (
        entry.name === "mimetype" ||
        entry.name === "[Content_Types].xml" ||
        entry.name === "word/document.xml" ||
        entry.name === "xl/workbook.xml" ||
        entry.name === "xl/sharedStrings.xml" ||
        entry.name === "content.xml" ||
        /^xl\/worksheets\/[^/]+\.xml$/u.test(entry.name)
      );
    },
  });
  const xml = (name: string) => {
    return archive[name] ? strFromU8(archive[name]) : "";
  };
  if (extension === "docx" || extension === "xlsx") {
    const main = extension === "docx" ? "word/document.xml" : "xl/workbook.xml";
    const mainMime =
      extension === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
    if (!archive[main] || !xml("[Content_Types].xml").includes(mainMime)) {
      invalidSource("The file does not match its document format");
    }
  } else if (xml("mimetype") !== sourceMimeType || !archive["content.xml"]) {
    invalidSource("The file does not match its OpenDocument format");
  }
  if (extension === "xlsx") {
    for (const [name, bytes] of Object.entries(archive)) {
      if (
        name !== "xl/sharedStrings.xml" &&
        !name.startsWith("xl/worksheets/")
      ) {
        continue;
      }
      for (const cell of strFromU8(bytes).matchAll(
        /<(?:\w+:)?(?:si|is)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:si|is)>/gu,
      )) {
        const text = [
          ...cell[1]!.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gu),
        ]
          .map((part) => {
            return decodeXML(part[1]!);
          })
          .join("");
        if (text.length > MAX_CELL_CHARACTERS) {
          invalidSource("A cell exceeds Google Sheets' 50,000 character limit");
        }
      }
    }
  }
}

export function prepareGoogleWorkspaceImport(
  source: { readonly filename: string; readonly file: Buffer },
  target: Exclude<GoogleWorkspaceTarget, "presentation">,
):
  | {
      readonly ok: true;
      readonly file: Buffer;
      readonly contentType: string;
      readonly filename: string;
    }
  | { readonly ok: false; readonly message: string } {
  const format = googleWorkspaceConversion(source.filename);
  if (!format || format.target !== target) {
    return {
      ok: false,
      message: "This file cannot be converted to the selected Google format",
    };
  }
  const maximumBytes = (target === "document" ? 50 : 100) * 1024 * 1024;
  if (source.file.byteLength > maximumBytes) {
    return {
      ok: false,
      message:
        "This file is too large to convert to the selected Google format",
    };
  }
  const prepared = safeSync(() => {
    let file = source.file;
    let contentType = format.sourceMimeType;
    if (["csv", "tsv", "txt", "md", "markdown"].includes(format.extension)) {
      const text = utf8(file);
      if (format.extension === "csv" || format.extension === "tsv") {
        file = textWorkbook(
          delimitedRows(text, format.extension === "csv" ? "," : "\t"),
        );
        contentType = XLSX_MIME;
      } else if (text.length > 1_020_000) {
        invalidSource("This document exceeds Google Docs' character limit");
      }
    } else if (format.extension === "rtf") {
      if (
        !file
          .subarray(0, 16)
          .toString("ascii")
          .startsWith(String.raw`{\rtf`)
      ) {
        invalidSource("The file does not contain an RTF document");
      }
    } else {
      checkOfficeSource(file, format.extension, format.sourceMimeType);
      if (format.extension === "docx") {
        file = prepareGoogleDocsFonts(file);
      }
    }
    return {
      file,
      contentType,
      filename: source.filename.replace(/\.[^.]+$/u, "").trim() || "Untitled",
    };
  });
  return "ok" in prepared
    ? { ok: true, ...prepared.ok }
    : {
        ok: false,
        message:
          prepared.error instanceof ImportSourceError
            ? prepared.error.message
            : "This file is damaged, encrypted, or does not match its document format",
      };
}
