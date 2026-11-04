import { createHash } from "node:crypto";
import { posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 501;

export class RegistryArchiveValidationError extends Error {}

interface RegistryResourceArchive {
  readonly format: "registry-tar-gzip-v1";
  readonly sha256: string;
  readonly archiveBytes: number;
}

/** Preserve published tar.gz bytes and their pinned digest; do not canonicalize them. */
export function registryResourceArchiveKey(sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new RegistryArchiveValidationError("Invalid registry archive digest");
  }
  return `registry-archives/v1/${sha256}.tar.gz`;
}

function archivePath(value: string, directory: boolean): string {
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-z]:/iu.test(path) ||
    path.split("/").some((part) => {
      return part === "..";
    }) ||
    posix.normalize(path) !== path ||
    path === "."
  ) {
    throw new RegistryArchiveValidationError("Unsafe registry archive path");
  }
  return path;
}

/** Validate in memory without extracting or changing an already published archive. */
export function inspectRegistryResourceArchive(
  archive: Buffer,
  expectedSha256: string | undefined,
  sourcePath: string,
) {
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new RegistryArchiveValidationError(
      "Registry archive digest mismatch",
    );
  }
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new RegistryArchiveValidationError(
      "Registry archive exceeds compressed byte limit",
    );
  }
  const root = archivePath(sourcePath, true);
  const bytes = gunzipSync(archive, {
    maxOutputLength: MAX_CONTENT_BYTES + 2 * 1024 * 1024,
  });
  const paths = new Map<string, boolean>();
  let fileCount = 0;
  let totalBytes = 0;
  let failure: unknown;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      try {
        const directory = entry.type === "Directory";
        if (!directory && !["File", "OldFile"].includes(entry.type)) {
          throw new RegistryArchiveValidationError(
            "Unsupported registry archive entry",
          );
        }
        if (
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          (directory && entry.size !== 0)
        ) {
          throw new RegistryArchiveValidationError(
            "Invalid registry archive entry size",
          );
        }
        const path = archivePath(entry.path, directory);
        const packageMember = path === root || path.startsWith(`${root}/`);
        const parentDirectory = directory && root.startsWith(`${path}/`);
        if (!packageMember && !parentDirectory) {
          throw new RegistryArchiveValidationError(
            "Registry archive path is outside its package",
          );
        }
        if (paths.has(path)) {
          throw new RegistryArchiveValidationError(
            "Registry archive has a duplicated path",
          );
        }
        paths.set(path, directory);
        if (!directory) {
          fileCount += 1;
          totalBytes += entry.size;
          if (fileCount > MAX_FILES || totalBytes > MAX_CONTENT_BYTES) {
            throw new RegistryArchiveValidationError(
              "Registry archive exceeds file or expanded byte limit",
            );
          }
        }
      } catch (error) {
        failure ??= error;
      }
      entry.resume();
    },
  });
  parser.on("error", (error) => {
    failure ??= error;
  });
  parser.end(bytes);
  if (failure) throw failure;
  if (fileCount === 0)
    throw new RegistryArchiveValidationError(
      "Registry archive contains no files",
    );
  for (const path of paths.keys()) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.get(parts.join("/")) === false) {
        throw new RegistryArchiveValidationError(
          "Registry archive file conflicts with a directory",
        );
      }
      parts.pop();
    }
  }
  const descriptor: RegistryResourceArchive = {
    format: "registry-tar-gzip-v1",
    sha256,
    archiveBytes: archive.length,
  };
  return { descriptor, fileCount, totalBytes };
}
