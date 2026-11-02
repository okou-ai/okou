/** SFNT is a binary file-format boundary: use a real OFL font and independent
 * directory/checksum readers to guard against dropped shaping tables. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { nativeFontTools } from "../font-binary";

const source = new Uint8Array(
  readFileSync(
    new URL(
      "./fixtures/convert/fonts/geist-latin-variable.ttf",
      import.meta.url,
    ),
  ),
).buffer;

function directory(buffer: ArrayBuffer): Map<string, Buffer> {
  const bytes = Buffer.from(buffer),
    result = new Map<string, Buffer>();
  for (let i = 0; i < bytes.readUInt16BE(4); i++) {
    const p = 12 + 16 * i,
      offset = bytes.readUInt32BE(p + 8),
      length = bytes.readUInt32BE(p + 12);
    result.set(
      bytes.toString("ascii", p, p + 4),
      bytes.subarray(offset, offset + length),
    );
  }
  return result;
}

function names(buffer: Buffer): Map<number, string> {
  const result = new Map<number, string>(),
    start = buffer.readUInt16BE(4);
  for (let i = 0; i < buffer.readUInt16BE(2); i++) {
    const p = 6 + i * 12;
    if (buffer.readUInt16BE(p) !== 3) continue;
    const offset = start + buffer.readUInt16BE(p + 10),
      length = buffer.readUInt16BE(p + 8);
    result.set(
      buffer.readUInt16BE(p + 6),
      Buffer.from(buffer.subarray(offset, offset + length))
        .swap16()
        .toString("utf16le"),
    );
  }
  return result;
}

describe("native presentation font binaries", () => {
  it("renames a font without changing glyphs, metrics, positioning or substitutions", () => {
    const output = nativeFontTools().rename(source, "Geist 600 fixture");
    const before = directory(source),
      after = directory(output);
    expect([...after.keys()]).toEqual([...before.keys()].sort());
    for (const [tag, bytes] of before) {
      if (["name", "head", "OS/2"].includes(tag)) continue;
      expect(after.get(tag), tag).toEqual(bytes);
    }
    for (const tag of ["GPOS", "GSUB", "GDEF", "hmtx", "glyf", "gvar", "fvar"])
      expect(after.get(tag)?.byteLength, tag).toBeGreaterThan(0);
    const nameTable = after.get("name");
    if (nameTable === undefined) throw new Error("Missing name table");
    const originalNames = before.get("name");
    if (originalNames === undefined) throw new Error("Missing original names");
    const renamed = names(nameTable),
      original = names(originalNames);
    expect(renamed.get(1)).toBe("Geist 600 fixture");
    expect(renamed.get(2)).toBe("Regular");
    for (const id of [0, 5, 8, 9, 13, 14])
      expect(renamed.get(id)).toBe(original.get(id));
    let checksum = 0;
    const bytes = Buffer.from(output);
    for (let p = 0; p < bytes.length; p += 4)
      checksum = (checksum + bytes.readUInt32BE(p)) >>> 0;
    expect(checksum).toBe(0xb1b0afba);
  });

  it("preserves glyph coverage and distinguishes missing fallback glyphs", () => {
    const font = nativeFontTools(),
      before = font.coverage(source),
      after = font.coverage(font.rename(source, "Geist fixture"));
    for (const char of "0123456789 AVATAR decoration. It café") {
      const code = char.codePointAt(0);
      if (code === undefined) throw new Error("Missing codepoint");
      expect(before(code), char).toBe(true);
      expect(after(code), char).toBe(true);
    }
    for (const code of [0x4e2d, 0x1f600, 0x10ffff])
      expect(after(code)).toBe(false);
  });

  it("preserves CFF outlines and CJK glyph coverage", () => {
    const cff = new Uint8Array(
      readFileSync(
        new URL(
          "./fixtures/convert/fonts/noto-cjk-fixture.otf",
          import.meta.url,
        ),
      ),
    ).buffer;
    const output = nativeFontTools().rename(cff, "CJK fixture");
    const before = directory(cff),
      after = directory(output);
    expect(after.get("CFF ")?.byteLength).toBeGreaterThan(0);
    for (const [tag, bytes] of before) {
      if (["name", "head", "OS/2"].includes(tag)) continue;
      expect(after.get(tag), tag).toEqual(bytes);
    }
    expect(nativeFontTools().coverage(output)(0x4e2d)).toBe(true);
  });

  it("extracts collection faces with absolute shared-table offsets losslessly", () => {
    const collection = new Uint8Array(
      readFileSync(
        new URL(
          "./fixtures/convert/fonts/collection-fixture.ttc",
          import.meta.url,
        ),
      ),
    ).buffer;
    const font = nativeFontTools(),
      first = font.standalone(collection),
      second = font.standalone(collection, 1);
    const cff = new Uint8Array(
      readFileSync(
        new URL(
          "./fixtures/convert/fonts/noto-cjk-fixture.otf",
          import.meta.url,
        ),
      ),
    ).buffer;
    for (const [original, extracted] of [
      [cff, first],
      [source, second],
    ] as const) {
      const before = directory(original),
        after = directory(extracted);
      expect([...after.keys()]).toEqual([...before.keys()].sort());
      for (const [tag, bytes] of before) {
        if (tag === "head") continue;
        expect(after.get(tag), tag).toEqual(bytes);
      }
      let checksum = 0;
      const bytes = Buffer.from(extracted);
      for (let p = 0; p < bytes.length; p += 4)
        checksum = (checksum + bytes.readUInt32BE(p)) >>> 0;
      expect(checksum).toBe(0xb1b0afba);
    }
    expect(font.coverage(first)(0x4e2d)).toBe(true);
    expect(font.coverage(second)(0x4e2d)).toBe(false);
    expect(font.coverage(second)(0x41)).toBe(true);
    expect(font.standalone(source)).toBe(source);
    expect(() => {
      return font.standalone(collection, 2);
    }).toThrow("Invalid presentation font collection face");
    const corrupt = collection.slice(0);
    new DataView(corrupt).setUint32(12, 0xfffffff0);
    expect(() => {
      return font.standalone(corrupt);
    }).toThrow("Truncated presentation font directory");
  });

  it("rejects truncated and out-of-bounds font directories", () => {
    expect(() => {
      return nativeFontTools().rename(source.slice(0, 8), "Broken");
    }).toThrow("Truncated");
    const corrupt = source.slice(0);
    new DataView(corrupt).setUint32(20, 0xfffffff0);
    expect(() => {
      return nativeFontTools().rename(corrupt, "Broken");
    }).toThrow("Invalid presentation font table");
  });
});
