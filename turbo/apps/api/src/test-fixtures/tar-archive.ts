/**
 * Hand-built TAR archives for storage states no product endpoint can publish.
 *
 * The canonical volume publisher always writes one regular file per path, so a
 * bucket carrying a symlink, a directory or a duplicated entry at the canonical
 * instruction path is an infrastructure state rather than a user action. These
 * builders construct those bytes exactly, at the storage boundary, so a reader
 * can be tested against them without ever following a link or touching a real
 * bucket.
 */

const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_COUNT = 2;

interface TarEntryInput {
  readonly path: string;
  /**
   * The POSIX `typeflag`: `0` a regular file, `2` a symbolic link that nothing
   * in this repository follows, `5` a directory.
   */
  readonly type: "0" | "2" | "5";
  readonly content?: Buffer;
  readonly linkname?: string;
}

function writeField(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  header.write(value.slice(0, length - 1), offset, "utf8");
}

function octalField(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** One ustar entry: a 512-byte header followed by block-padded content. */
export function tarEntry(entry: TarEntryInput): Buffer {
  const content = entry.content ?? Buffer.alloc(0);
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  writeField(header, entry.path, 0, 100);
  writeField(header, octalField(0o644, 8), 100, 8);
  writeField(header, octalField(0, 8), 108, 8);
  writeField(header, octalField(0, 8), 116, 8);
  writeField(header, octalField(content.length, 12), 124, 12);
  writeField(header, octalField(0, 12), 136, 12);
  // The checksum is computed with its own field read as spaces.
  header.write("        ", 148, "utf8");
  header.write(entry.type, 156, "utf8");
  writeField(header, entry.linkname ?? "", 157, 100);
  header.write("ustar\0", 257, "utf8");
  header.write("00", 263, "utf8");
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  const padded = Buffer.alloc(
    Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE,
    0,
  );
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

/** The entries in order, closed by the canonical two zero-filled end blocks. */
export function tarArchive(entries: readonly Buffer[]): Buffer {
  return Buffer.concat([
    ...entries,
    Buffer.alloc(TAR_BLOCK_SIZE * TAR_END_BLOCK_COUNT, 0),
  ]);
}
