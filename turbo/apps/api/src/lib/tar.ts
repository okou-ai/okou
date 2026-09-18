import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_COUNT = 2;

interface ExtractedTarFile {
  readonly path: string;
  readonly content: string;
}

interface ExtractedBinaryTarFile {
  readonly path: string;
  readonly content: Buffer;
}

/**
 * Every entry claiming one of the requested paths, whatever its type.
 *
 * The ordinary extractors drop nonregular entries, which is right for callers
 * that only want file contents but hides the fact that a path was claimed. A
 * caller that must prove a path resolves to exactly one regular file needs to
 * see the symlink or directory that also claimed it, so it is reported here
 * with a null body rather than filtered away. Nothing in this module follows a
 * link.
 */
interface TarTargetOccurrence {
  readonly path: string;
  readonly content: Buffer | null;
}

function normalizeTarPath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** The entry types that carry file bytes; everything else is a claim only. */
function isRegularTarEntry(type: string): boolean {
  return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

function isEmptyTarArchive(buffer: Buffer): boolean {
  return (
    buffer.length >= TAR_BLOCK_SIZE * TAR_END_BLOCK_COUNT &&
    buffer.length % TAR_BLOCK_SIZE === 0 &&
    buffer.every((byte) => {
      return byte === 0;
    })
  );
}

function parseTarGz(
  gzBuffer: Buffer,
  targetPaths: readonly string[] | undefined,
  maxOutputBytes: number | undefined,
  includeNonRegular: boolean,
): readonly TarTargetOccurrence[] {
  const tarBuffer =
    maxOutputBytes === undefined
      ? gunzipSync(gzBuffer)
      : gunzipSync(gzBuffer, { maxOutputLength: maxOutputBytes });
  const normalizedTargets = targetPaths
    ? new Set(
        targetPaths.map((path) => {
          return normalizeTarPath(path);
        }),
      )
    : null;
  // A canonical empty TAR consists only of the two zero-filled end blocks.
  // node-tar's strict parser reports TAR_BAD_ARCHIVE when it sees no entries,
  // so recognize this valid archive shape before handing non-empty input to it.
  if (isEmptyTarArchive(tarBuffer)) {
    return [];
  }
  const entries: TarTargetOccurrence[] = [];
  let parseError: unknown;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      const path = normalizeTarPath(entry.path);
      const regular = isRegularTarEntry(entry.type);
      if (
        (!regular && !includeNonRegular) ||
        (normalizedTargets !== null && !normalizedTargets.has(path))
      ) {
        entry.resume();
        return;
      }
      if (!regular) {
        // A symlink or a directory has no body to read, and following either
        // one is exactly what this must not do: record the claim and move on.
        entries.push({ path, content: null });
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        entries.push({ path, content: Buffer.concat(chunks) });
      });
    },
  });
  parser.on("error", (error) => {
    parseError = error;
  });
  parser.end(tarBuffer);
  if (parseError !== undefined) {
    throw parseError;
  }
  return entries;
}

export function extractBinaryFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
  maxOutputBytes?: number,
): readonly ExtractedBinaryTarFile[] {
  return parseTarGz(gzBuffer, targetPaths, maxOutputBytes, false).flatMap(
    (entry) => {
      // Nonregular entries were never collected for this caller, so there is
      // no bodiless entry here to invent an empty buffer for.
      return entry.content === null
        ? []
        : [{ path: entry.path, content: entry.content }];
    },
  );
}

/**
 * Every entry claiming one of these paths, including the nonregular ones.
 *
 * Filtering by type before counting is how a regular file and a same-path
 * symlink look like a single unambiguous file. A caller that requires one
 * regular file at a promised path has to see both claims to reject them, so
 * this is deliberately separate from the extractors above and leaves their
 * behaviour untouched.
 */
export function extractTarGzTargetOccurrences(
  gzBuffer: Buffer,
  targetPaths: readonly string[],
  maxOutputBytes: number,
): readonly TarTargetOccurrence[] {
  return parseTarGz(gzBuffer, targetPaths, maxOutputBytes, true);
}

export function extractFilesFromTarGz(
  gzBuffer: Buffer,
  targetPaths?: readonly string[],
  maxOutputBytes?: number,
): readonly ExtractedTarFile[] {
  return extractBinaryFilesFromTarGz(gzBuffer, targetPaths, maxOutputBytes).map(
    (file) => {
      return { path: file.path, content: file.content.toString("utf8") };
    },
  );
}

export function extractFileFromTarGz(
  gzBuffer: Buffer,
  targetPath: string,
): string | null {
  const normalized = normalizeTarPath(targetPath);
  const file = extractFilesFromTarGz(gzBuffer, [normalized]).find((item) => {
    return item.path === normalized;
  });
  return file?.content ?? null;
}
