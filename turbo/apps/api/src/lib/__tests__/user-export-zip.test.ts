import AdmZip from "adm-zip";
import { expect, test } from "vitest";

import { testContext } from "../../__tests__/test-context";
import {
  planUserExportZipRange,
  serializeUserExportZipCentralHeader,
  serializeUserExportZipEnd,
  serializeUserExportZipLocalHeader,
  updateUserExportCrc32,
  userExportZipEntryLayout,
  type UserExportZipRangeFragment,
  type UserExportZipRangeSegment,
} from "../user-export-zip";

testContext();

interface ExportFile {
  readonly path: string;
  /** Immutable source objects in order; empty chunks are allowed. */
  readonly chunks: readonly Buffer[];
}

/** Lays the export out exactly as a resumable export persists it. */
function buildExport(files: readonly ExportFile[]) {
  const sources = new Map<string, Buffer>();
  const segments: UserExportZipRangeSegment[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    let crc = 0;
    let size = 0;
    for (const chunk of file.chunks) {
      crc = updateUserExportCrc32(crc, chunk);
      size += chunk.length;
    }
    const layout = userExportZipEntryLayout({
      path: file.path,
      size,
      localHeaderOffset: offset,
    });
    const local = serializeUserExportZipLocalHeader({
      path: file.path,
      size,
      crc32: crc,
    });
    expect(local).toHaveLength(layout.localHeaderSize);
    segments.push({ type: "bytes", offset, bytes: local });
    const centralHeader = serializeUserExportZipCentralHeader({
      path: file.path,
      size,
      crc32: crc,
      localHeaderOffset: offset,
    });
    expect(centralHeader).toHaveLength(layout.centralHeaderSize);
    central.push(centralHeader);
    let dataOffset = offset + layout.localHeaderSize;
    for (const [index, chunk] of file.chunks.entries()) {
      const sourceKey = `${file.path}#${index}`;
      sources.set(sourceKey, chunk);
      segments.push({
        type: "source",
        offset: dataOffset,
        size: chunk.length,
        sourceKey,
        sourceOffset: 0,
      });
      dataOffset += chunk.length;
    }
    offset = dataOffset;
  }
  const centralDirectoryOffset = offset;
  for (const header of central) {
    segments.push({ type: "bytes", offset, bytes: header });
    offset += header.length;
  }
  const end = serializeUserExportZipEnd({
    entryCount: files.length,
    centralDirectoryOffset,
    centralDirectorySize: offset - centralDirectoryOffset,
  });
  segments.push({ type: "bytes", offset, bytes: end });
  return { sources, segments, size: offset + end.length };
}

/** The consumer resolves source fragments from the immutable objects. */
function readFragments(
  sources: ReadonlyMap<string, Buffer>,
  fragments: readonly UserExportZipRangeFragment[],
): Buffer {
  return Buffer.concat(
    fragments.map((fragment) => {
      if (fragment.type === "bytes") {
        return fragment.bytes;
      }
      const source = sources.get(fragment.sourceKey);
      if (!source) {
        throw new Error(`Missing export source ${fragment.sourceKey}`);
      }
      return source.subarray(
        fragment.offset,
        fragment.offset + fragment.length,
      );
    }),
  );
}

test("user-export-zip-002 serializes an empty archive that ordinary ZIP readers open", () => {
  const archive = serializeUserExportZipEnd({
    entryCount: 0,
    centralDirectoryOffset: 0,
    centralDirectorySize: 0,
  });

  expect(new AdmZip(archive).getEntries()).toStrictEqual([]);
});

test("user-export-zip-001 recreates the same valid ZIP from 37-byte ranges across source and header boundaries", () => {
  const memory = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0xfe, 0x01]);
  const files: readonly ExportFile[] = [
    {
      path: "threads/events.jsonl",
      chunks: [
        Buffer.from('{"type":"message","text":"hello"}\n'),
        Buffer.alloc(0),
        Buffer.from('{"type":"message","text":"world"}\n'),
      ],
    },
    {
      path: "memory/记忆 ✓/notes.bin",
      chunks: [memory.subarray(0, 3), Buffer.alloc(0), memory.subarray(3)],
    },
    { path: "chats/empty-message.txt", chunks: [Buffer.alloc(0)] },
  ];
  const { sources, segments, size } = buildExport(files);

  const full = readFragments(
    sources,
    planUserExportZipRange({ offset: 0, length: size, segments }),
  );
  const ranges: Buffer[] = [];
  for (let offset = 0; offset < size; offset += 37) {
    ranges.push(
      readFragments(
        sources,
        planUserExportZipRange({
          offset,
          length: Math.min(37, size - offset),
          segments,
        }),
      ),
    );
  }
  const regenerated = readFragments(
    sources,
    planUserExportZipRange({ offset: 37, length: 37, segments }),
  );

  expect(regenerated.equals(ranges[1] ?? Buffer.alloc(0))).toBeTruthy();
  expect(Buffer.concat(ranges).equals(full)).toBeTruthy();
  const entries = new AdmZip(full).getEntries();
  expect(
    entries.map((entry) => {
      return entry.entryName;
    }),
  ).toStrictEqual(
    files.map((file) => {
      return file.path;
    }),
  );
  for (const [index, entry] of entries.entries()) {
    const file = files[index];
    if (!file) {
      throw new Error("Expected one input file per ZIP entry");
    }
    expect(entry.header.method).toBe(0);
    expect(entry.getData().equals(Buffer.concat(file.chunks))).toBeTruthy();
  }
});
