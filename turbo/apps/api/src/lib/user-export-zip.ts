import { crc32 } from "node:zlib";

const UINT16_MAX = 0xff_ff;
const UINT32_MAX = 0xff_ff_ff_ff;
const UTF8_FLAG = 0x08_00;
const DOS_DATE_1980_01_01 = 0x00_21;
const ZIP_VERSION = 20;
const ZIP64_VERSION = 45;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;

interface UserExportZipEntry {
  readonly path: string;
  readonly size: number;
  readonly crc32: number;
}

interface UserExportZipEntryPosition {
  readonly path: string;
  readonly size: number;
  readonly localHeaderOffset: number;
}

interface UserExportZipEnd {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
}

/** Absolute archive positions let callers load only the current part's rows. */
export type UserExportZipRangeSegment =
  | {
      readonly type: "bytes";
      readonly offset: number;
      readonly bytes: Buffer;
    }
  | {
      readonly type: "source";
      readonly offset: number;
      readonly size: number;
      readonly sourceKey: string;
      readonly sourceOffset: number;
    };

export type UserExportZipRangeFragment =
  | { readonly type: "bytes"; readonly bytes: Buffer }
  | {
      readonly type: "source";
      readonly sourceKey: string;
      readonly offset: number;
      readonly length: number;
    };

function assertSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("User export ZIP size or offset must be a safe integer");
  }
}

function addSizes(left: number, right: number): number {
  assertSize(left);
  assertSize(right);
  const total = left + right;
  assertSize(total);
  return total;
}

function assertChecksum(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error("User export ZIP CRC32 must be an unsigned 32-bit integer");
  }
}

function encodePath(path: string): Buffer {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => {
      return part.length === 0 || part === "." || part === "..";
    })
  ) {
    throw new Error(`Unsafe user export ZIP path: ${path}`);
  }
  const encoded = Buffer.from(path, "utf8");
  if (encoded.length > UINT16_MAX || encoded.toString("utf8") !== path) {
    throw new Error("User export ZIP path must fit in 65535 UTF-8 bytes");
  }
  return encoded;
}

function zip64CentralExtraBytes(size: number, offset: number): number {
  const valueBytes =
    (size >= UINT32_MAX ? 16 : 0) + (offset >= UINT32_MAX ? 8 : 0);
  return valueBytes === 0 ? 0 : 4 + valueBytes;
}

/** Start at zero; the returned CRC can be persisted between immutable chunks. */
export function updateUserExportCrc32(
  previous: number,
  bytes: Uint8Array,
): number {
  assertChecksum(previous);
  return crc32(bytes, previous);
}

/** No archive inventory is needed to assign the next local and central offsets. */
export function userExportZipEntryLayout(entry: UserExportZipEntryPosition): {
  readonly localHeaderSize: number;
  readonly centralHeaderSize: number;
} {
  assertSize(entry.size);
  assertSize(entry.localHeaderOffset);
  const path = encodePath(entry.path);
  return {
    localHeaderSize:
      LOCAL_HEADER_BYTES + path.length + (entry.size >= UINT32_MAX ? 20 : 0),
    centralHeaderSize:
      CENTRAL_HEADER_BYTES +
      path.length +
      zip64CentralExtraBytes(entry.size, entry.localHeaderOffset),
  };
}

/** STORE has no compressor state or data descriptor: every retry emits the same bytes. */
export function serializeUserExportZipLocalHeader(
  entry: UserExportZipEntry,
): Buffer {
  assertSize(entry.size);
  assertChecksum(entry.crc32);
  const path = encodePath(entry.path);
  const zip64 = entry.size >= UINT32_MAX;
  const extraBytes = zip64 ? 20 : 0;
  const header = Buffer.alloc(LOCAL_HEADER_BYTES + path.length + extraBytes);
  header.writeUInt32LE(0x04_03_4b_50, 0);
  header.writeUInt16LE(zip64 ? ZIP64_VERSION : ZIP_VERSION, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(zip64 ? UINT32_MAX : entry.size, 18);
  header.writeUInt32LE(zip64 ? UINT32_MAX : entry.size, 22);
  header.writeUInt16LE(path.length, 26);
  header.writeUInt16LE(extraBytes, 28);
  path.copy(header, LOCAL_HEADER_BYTES);
  if (zip64) {
    const offset = LOCAL_HEADER_BYTES + path.length;
    header.writeUInt16LE(0x00_01, offset);
    header.writeUInt16LE(16, offset + 2);
    header.writeBigUInt64LE(BigInt(entry.size), offset + 4);
    header.writeBigUInt64LE(BigInt(entry.size), offset + 12);
  }
  return header;
}

export function serializeUserExportZipCentralHeader(
  entry: UserExportZipEntry & UserExportZipEntryPosition,
): Buffer {
  assertSize(entry.size);
  assertSize(entry.localHeaderOffset);
  assertChecksum(entry.crc32);
  const path = encodePath(entry.path);
  const extraBytes = zip64CentralExtraBytes(
    entry.size,
    entry.localHeaderOffset,
  );
  const version = extraBytes > 0 ? ZIP64_VERSION : ZIP_VERSION;
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES + path.length + extraBytes);
  header.writeUInt32LE(0x02_01_4b_50, 0);
  header.writeUInt16LE(0x03_00 + version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(Math.min(entry.size, UINT32_MAX), 20);
  header.writeUInt32LE(Math.min(entry.size, UINT32_MAX), 24);
  header.writeUInt16LE(path.length, 28);
  header.writeUInt16LE(extraBytes, 30);
  // Regular file, mode 0644, written by Unix. Extraction never creates links.
  header.writeUInt32LE(0x81_a4_00_00, 38);
  header.writeUInt32LE(Math.min(entry.localHeaderOffset, UINT32_MAX), 42);
  path.copy(header, CENTRAL_HEADER_BYTES);
  if (extraBytes > 0) {
    let offset = CENTRAL_HEADER_BYTES + path.length;
    header.writeUInt16LE(0x00_01, offset);
    header.writeUInt16LE(extraBytes - 4, offset + 2);
    offset += 4;
    if (entry.size >= UINT32_MAX) {
      header.writeBigUInt64LE(BigInt(entry.size), offset);
      header.writeBigUInt64LE(BigInt(entry.size), offset + 8);
      offset += 16;
    }
    if (entry.localHeaderOffset >= UINT32_MAX) {
      header.writeBigUInt64LE(BigInt(entry.localHeaderOffset), offset);
    }
  }
  return header;
}

/** Includes ZIP64 end records at the legacy format's sentinel boundaries. */
export function serializeUserExportZipEnd(end: UserExportZipEnd): Buffer {
  assertSize(end.entryCount);
  assertSize(end.centralDirectoryOffset);
  assertSize(end.centralDirectorySize);
  const centralEnd = addSizes(
    end.centralDirectoryOffset,
    end.centralDirectorySize,
  );
  const zip64 =
    end.entryCount >= UINT16_MAX ||
    end.centralDirectoryOffset >= UINT32_MAX ||
    end.centralDirectorySize >= UINT32_MAX;
  addSizes(centralEnd, zip64 ? 98 : 22);
  const header = Buffer.alloc(zip64 ? 98 : 22);
  let offset = 0;
  if (zip64) {
    header.writeUInt32LE(0x06_06_4b_50, 0);
    header.writeBigUInt64LE(44n, 4);
    header.writeUInt16LE(0x03_00 + ZIP64_VERSION, 12);
    header.writeUInt16LE(ZIP64_VERSION, 14);
    header.writeBigUInt64LE(BigInt(end.entryCount), 24);
    header.writeBigUInt64LE(BigInt(end.entryCount), 32);
    header.writeBigUInt64LE(BigInt(end.centralDirectorySize), 40);
    header.writeBigUInt64LE(BigInt(end.centralDirectoryOffset), 48);
    header.writeUInt32LE(0x07_06_4b_50, 56);
    header.writeBigUInt64LE(BigInt(centralEnd), 64);
    header.writeUInt32LE(1, 72);
    offset = 76;
  }
  header.writeUInt32LE(0x06_05_4b_50, offset);
  header.writeUInt16LE(Math.min(end.entryCount, UINT16_MAX), offset + 8);
  header.writeUInt16LE(Math.min(end.entryCount, UINT16_MAX), offset + 10);
  header.writeUInt32LE(
    Math.min(end.centralDirectorySize, UINT32_MAX),
    offset + 12,
  );
  header.writeUInt32LE(
    Math.min(end.centralDirectoryOffset, UINT32_MAX),
    offset + 16,
  );
  return header;
}

/**
 * Only pass segments intersecting this part. Headers are small byte segments;
 * file data stays in immutable source objects until the caller reads the range.
 */
export function planUserExportZipRange(args: {
  readonly offset: number;
  readonly length: number;
  readonly segments: readonly UserExportZipRangeSegment[];
}): readonly UserExportZipRangeFragment[] {
  const end = addSizes(args.offset, args.length);
  if (args.length === 0) {
    return [];
  }
  const segments = args.segments
    .filter((segment) => {
      const size =
        segment.type === "bytes" ? segment.bytes.length : segment.size;
      const segmentEnd = addSizes(segment.offset, size);
      if (segment.type === "source") {
        addSizes(segment.sourceOffset, size);
      }
      return size > 0 && segment.offset < end && segmentEnd > args.offset;
    })
    // filter() owns this array; sorting never mutates the caller's inventory.
    .sort((left, right) => {
      return left.offset - right.offset;
    });
  let cursor = args.offset;
  const fragments: UserExportZipRangeFragment[] = [];
  for (const segment of segments) {
    const start = Math.max(args.offset, segment.offset);
    if (start !== cursor) {
      throw new Error("User export ZIP range contains a gap or overlap");
    }
    const size = segment.type === "bytes" ? segment.bytes.length : segment.size;
    const segmentEnd = Math.min(end, addSizes(segment.offset, size));
    const relativeOffset = start - segment.offset;
    const length = segmentEnd - start;
    if (segment.type === "bytes") {
      fragments.push({
        type: "bytes",
        bytes: segment.bytes.subarray(relativeOffset, relativeOffset + length),
      });
    } else {
      fragments.push({
        type: "source",
        sourceKey: segment.sourceKey,
        offset: addSizes(segment.sourceOffset, relativeOffset),
        length,
      });
    }
    cursor = segmentEnd;
  }
  if (cursor !== end) {
    throw new Error("User export ZIP range is incomplete");
  }
  return fragments;
}
