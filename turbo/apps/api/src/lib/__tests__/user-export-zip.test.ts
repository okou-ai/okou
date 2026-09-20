import AdmZip from "adm-zip";

import {
  planUserExportZipRange,
  serializeUserExportZipCentralHeader,
  serializeUserExportZipEnd,
  serializeUserExportZipLocalHeader,
  updateUserExportCrc32,
  userExportZipEntryLayout,
  type UserExportZipRangeSegment,
} from "../user-export-zip";

// ZIP bytes are a public file-format boundary. Sparse >4 GiB offsets cannot be
// constructed through the export API without staging gigabytes of test data.
// The ZIP64 cases check the format's published fields; route tests cover jobs.

function archiveFixture(
  files: readonly {
    readonly path: string;
    readonly chunks: readonly Buffer[];
  }[],
) {
  const segments: UserExportZipRangeSegment[] = [];
  const centralHeaders: Buffer[] = [];
  const sources = new Map<string, Buffer>();
  let localOffset = 0;
  for (const [fileIndex, file] of files.entries()) {
    const entry = {
      path: file.path,
      size: file.chunks.reduce((size, chunk) => {
        return size + chunk.length;
      }, 0),
      crc32: file.chunks.reduce((checksum, chunk) => {
        return updateUserExportCrc32(checksum, chunk);
      }, 0),
      localHeaderOffset: localOffset,
    };
    const localHeader = serializeUserExportZipLocalHeader(entry);
    segments.push({ type: "bytes", offset: localOffset, bytes: localHeader });
    localOffset += localHeader.length;
    for (const [chunkIndex, chunk] of file.chunks.entries()) {
      const sourceKey = `file-${fileIndex}/chunk-${chunkIndex}`;
      const prefix = Buffer.from("prefix");
      sources.set(sourceKey, Buffer.concat([prefix, chunk]));
      segments.push({
        type: "source",
        offset: localOffset,
        size: chunk.length,
        sourceKey,
        sourceOffset: prefix.length,
      });
      localOffset += chunk.length;
    }
    centralHeaders.push(serializeUserExportZipCentralHeader(entry));
  }
  const centralDirectoryOffset = localOffset;
  for (const bytes of centralHeaders) {
    segments.push({ type: "bytes", offset: localOffset, bytes });
    localOffset += bytes.length;
  }
  const end = serializeUserExportZipEnd({
    entryCount: files.length,
    centralDirectoryOffset,
    centralDirectorySize: localOffset - centralDirectoryOffset,
  });
  segments.push({ type: "bytes", offset: localOffset, bytes: end });
  return { segments, sources, size: localOffset + end.length };
}

function readArchiveRange(
  fixture: ReturnType<typeof archiveFixture>,
  offset: number,
  length: number,
): Buffer {
  const fragments = planUserExportZipRange({
    offset,
    length,
    segments: fixture.segments,
  });
  return Buffer.concat(
    fragments.map((fragment) => {
      if (fragment.type === "bytes") {
        return fragment.bytes;
      }
      const source = fixture.sources.get(fragment.sourceKey);
      if (!source) {
        throw new Error(`Missing test source ${fragment.sourceKey}`);
      }
      return source.subarray(
        fragment.offset,
        fragment.offset + fragment.length,
      );
    }),
  );
}

describe("resumable user export ZIP format", () => {
  it("recreates the same valid ZIP when ranges are assembled across source and header boundaries", () => {
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x61, 0x80, 0x0a]);
    const files = [
      { path: "chat-threads.jsonl", chunks: [Buffer.from('{"id":"t"}\n')] },
      {
        path: "memory/org/记忆.bin",
        chunks: [binary.subarray(0, 2), Buffer.alloc(0), binary.subarray(2)],
      },
      { path: "chat-messages/empty.jsonl", chunks: [] },
    ];
    const fixture = archiveFixture(files);
    const complete = readArchiveRange(fixture, 0, fixture.size);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < fixture.size; offset += 37) {
      parts.push(
        readArchiveRange(fixture, offset, Math.min(37, fixture.size - offset)),
      );
    }
    // A replacement invocation can regenerate any completed or interrupted part.
    expect(readArchiveRange(fixture, 37, 37)).toStrictEqual(parts[1]);
    expect(Buffer.concat(parts)).toStrictEqual(complete);
    const zip = new AdmZip(Buffer.concat(parts));
    expect(
      zip.getEntries().map((entry) => {
        return entry.entryName;
      }),
    ).toStrictEqual(
      files.map((file) => {
        return file.path;
      }),
    );
    for (const file of files) {
      const entry = zip.getEntry(file.path);
      expect(entry?.getData()).toStrictEqual(Buffer.concat(file.chunks));
      expect(entry?.header.method).toBe(0);
    }
  });

  it("serializes an empty archive that ordinary ZIP readers open", () => {
    const end = serializeUserExportZipEnd({
      entryCount: 0,
      centralDirectoryOffset: 0,
      centralDirectorySize: 0,
    });
    expect(new AdmZip(end).getEntries()).toStrictEqual([]);
  });

  it("resumes CRC32 from its persisted unsigned value", () => {
    const first = updateUserExportCrc32(0, Buffer.from("1234"));
    const persisted = JSON.stringify(first);
    const checkpoint: unknown = JSON.parse(persisted);
    if (typeof checkpoint !== "number") {
      throw new Error("Expected a numeric checksum checkpoint");
    }
    expect(updateUserExportCrc32(checkpoint, Buffer.from("56789"))).toBe(
      0xcb_f4_39_26,
    );
  });

  it("uses ZIP64 size and offset fields exactly at legacy sentinel values", () => {
    const entry = {
      path: "large.bin",
      size: 0xff_ff_ff_ff,
      crc32: 0,
      localHeaderOffset: 0xff_ff_ff_ff + 123,
    };
    const local = serializeUserExportZipLocalHeader(entry);
    const central = serializeUserExportZipCentralHeader(entry);
    const layout = userExportZipEntryLayout(entry);
    expect(local).toHaveLength(layout.localHeaderSize);
    expect(central).toHaveLength(layout.centralHeaderSize);
    expect(local.readUInt16LE(4)).toBe(45);
    expect(local.readUInt32LE(18)).toBe(0xff_ff_ff_ff);
    const localExtra = 30 + Buffer.byteLength(entry.path);
    expect(local.readUInt16LE(localExtra)).toBe(1);
    expect(local.readBigUInt64LE(localExtra + 4)).toBe(BigInt(entry.size));
    expect(local.readBigUInt64LE(localExtra + 12)).toBe(BigInt(entry.size));
    const centralExtra = 46 + Buffer.byteLength(entry.path);
    expect(central.readUInt32LE(42)).toBe(0xff_ff_ff_ff);
    expect(central.readUInt16LE(centralExtra)).toBe(1);
    expect(central.readBigUInt64LE(centralExtra + 4)).toBe(BigInt(entry.size));
    expect(central.readBigUInt64LE(centralExtra + 12)).toBe(BigInt(entry.size));
    expect(central.readBigUInt64LE(centralExtra + 20)).toBe(
      BigInt(entry.localHeaderOffset),
    );
  });

  it("keeps ZIP64 offset-only extras in their specified position", () => {
    const entry = {
      path: "small.bin",
      size: 42,
      crc32: 0,
      localHeaderOffset: 0xff_ff_ff_ff,
    };
    const central = serializeUserExportZipCentralHeader(entry);
    const extraOffset = 46 + Buffer.byteLength(entry.path);
    expect(central.readUInt32LE(24)).toBe(42);
    expect(central.readUInt16LE(extraOffset + 2)).toBe(8);
    expect(central.readBigUInt64LE(extraOffset + 4)).toBe(0xff_ff_ff_ffn);
  });

  it.each([
    {
      entryCount: 65_535,
      centralDirectoryOffset: 500,
      centralDirectorySize: 70,
    },
    {
      entryCount: 1,
      centralDirectoryOffset: 0xff_ff_ff_ff,
      centralDirectorySize: 70,
    },
    {
      entryCount: 1,
      centralDirectoryOffset: 500,
      centralDirectorySize: 0xff_ff_ff_ff,
    },
  ])(
    "emits ZIP64 end and locator records for overflowing $entryCount entries",
    (end) => {
      const bytes = serializeUserExportZipEnd(end);
      expect(bytes.readUInt32LE(0)).toBe(0x06_06_4b_50);
      expect(bytes.readBigUInt64LE(32)).toBe(BigInt(end.entryCount));
      expect(bytes.readBigUInt64LE(40)).toBe(BigInt(end.centralDirectorySize));
      expect(bytes.readBigUInt64LE(48)).toBe(
        BigInt(end.centralDirectoryOffset),
      );
      expect(bytes.readUInt32LE(56)).toBe(0x07_06_4b_50);
      expect(bytes.readBigUInt64LE(64)).toBe(
        BigInt(end.centralDirectoryOffset + end.centralDirectorySize),
      );
      expect(bytes.readUInt32LE(76)).toBe(0x06_05_4b_50);
    },
  );

  it.each([
    "",
    "/absolute",
    "../escape",
    "a/../b",
    "a//b",
    String.raw`a\b`,
    "C:drive",
    "nul\0byte",
    "\ud800",
  ])("rejects an unsafe archive filename %j", (path) => {
    expect(() => {
      serializeUserExportZipLocalHeader({ path, size: 0, crc32: 0 });
    }).toThrow(/Unsafe user export ZIP path|UTF-8 bytes/);
  });

  it("rejects a filename larger than the ZIP format allows", () => {
    expect(() => {
      serializeUserExportZipLocalHeader({
        path: "x".repeat(65_536),
        size: 0,
        crc32: 0,
      });
    }).toThrow("65535 UTF-8 bytes");
  });

  it("rejects incomplete or overlapping input instead of uploading corrupt ranges", () => {
    expect(() => {
      planUserExportZipRange({
        offset: 0,
        length: 10,
        segments: [{ type: "bytes", offset: 0, bytes: Buffer.alloc(9) }],
      });
    }).toThrow("incomplete");
    expect(() => {
      planUserExportZipRange({
        offset: 0,
        length: 10,
        segments: [
          { type: "bytes", offset: 0, bytes: Buffer.alloc(6) },
          { type: "bytes", offset: 5, bytes: Buffer.alloc(5) },
        ],
      });
    }).toThrow("gap or overlap");
  });
});
