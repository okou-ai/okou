import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { tarArchive, tarEntry } from "../../test-fixtures/tar-archive";
import {
  extractBinaryFilesFromTarGz,
  extractTarGzTargetOccurrences,
} from "../tar";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function archiveOf(entries: readonly Buffer[]): Buffer {
  return gzipSync(tarArchive([...entries]));
}

describe("TAR extraction", () => {
  it("accepts a canonical empty archive", () => {
    const archive = gzipSync(Buffer.alloc(1024));

    expect(extractBinaryFilesFromTarGz(archive)).toStrictEqual([]);
  });

  it("rejects an incomplete empty archive", () => {
    const archive = gzipSync(Buffer.alloc(512));

    expect(() => {
      return extractBinaryFilesFromTarGz(archive);
    }).toThrow(/TAR_BAD_ARCHIVE/u);
  });

  it("keeps hiding nonregular entries from the file extractors", () => {
    // Every other caller wants file contents and nothing else, so a symlink
    // beside a file stays invisible to them.
    const archive = archiveOf([
      tarEntry({ path: "SKILL.md", type: "0", content: Buffer.from("real") }),
      tarEntry({ path: "SKILL.md", type: "2", linkname: "elsewhere.md" }),
      tarEntry({ path: "docs", type: "5" }),
    ]);

    expect(
      extractBinaryFilesFromTarGz(archive, ["SKILL.md"], MAX_OUTPUT_BYTES),
    ).toStrictEqual([{ path: "SKILL.md", content: Buffer.from("real") }]);
  });
});

describe("TAR target occurrences", () => {
  it("reports every claim on a target path, nonregular ones included", () => {
    const archive = archiveOf([
      tarEntry({ path: "CLAUDE.md", type: "0", content: Buffer.from("real") }),
      tarEntry({ path: "CLAUDE.md", type: "2", linkname: "elsewhere.md" }),
      tarEntry({ path: "OTHER.md", type: "0", content: Buffer.from("other") }),
    ]);

    expect(
      extractTarGzTargetOccurrences(archive, ["CLAUDE.md"], MAX_OUTPUT_BYTES),
    ).toStrictEqual([
      { path: "CLAUDE.md", content: Buffer.from("real") },
      { path: "CLAUDE.md", content: null },
    ]);
  });

  it("reports a directory claiming the target without reading anything", () => {
    const archive = archiveOf([tarEntry({ path: "CLAUDE.md", type: "5" })]);

    expect(
      extractTarGzTargetOccurrences(archive, ["CLAUDE.md"], MAX_OUTPUT_BYTES),
    ).toStrictEqual([{ path: "CLAUDE.md", content: null }]);
  });

  it("normalizes a leading ./ the way the extractors do", () => {
    const archive = archiveOf([
      tarEntry({
        path: "./CLAUDE.md",
        type: "0",
        content: Buffer.from("real"),
      }),
    ]);

    expect(
      extractTarGzTargetOccurrences(archive, ["CLAUDE.md"], MAX_OUTPUT_BYTES),
    ).toStrictEqual([{ path: "CLAUDE.md", content: Buffer.from("real") }]);
  });

  it("refuses to decompress past the ceiling it was given", () => {
    const archive = archiveOf([
      tarEntry({
        path: "CLAUDE.md",
        type: "0",
        content: Buffer.alloc(4096, 0x61),
      }),
    ]);

    expect(() => {
      return extractTarGzTargetOccurrences(archive, ["CLAUDE.md"], 1024);
    }).toThrow(
      expect.objectContaining({ code: "ERR_BUFFER_TOO_LARGE" }) as Error,
    );
  });
});
