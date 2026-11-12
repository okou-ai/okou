import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import { prepareCanonicalBundleArchive } from "./content-bundle-archive";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import { workflowAttachmentPath } from "./workflow-attachment-bundle";

export interface ContentBundleFile {
  readonly path: string;
  readonly content: Buffer;
  readonly mode?: 0o600 | 0o644 | 0o755;
}
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 501;

export function contentBundleKey(hash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hash))
    throw new Error("Invalid content bundle hash");
  return `bundles/v1/${hash}.tar.gz`;
}

export function contentBundleDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateFiles(
  input: readonly ContentBundleFile[],
): readonly ContentBundleFile[] {
  const files = [...input].sort((a, b) => {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const paths = new Set<string>();
  let size = 0;
  for (const file of files) {
    if (workflowAttachmentPath(file.path) !== file.path || paths.has(file.path))
      throw new Error("Ambiguous content bundle path");
    paths.add(file.path);
    if (file.mode !== undefined && ![0o600, 0o644, 0o755].includes(file.mode))
      throw new Error("Invalid content bundle file mode");
    size += file.content.length;
  }
  if (
    files.length === 0 ||
    files.length > MAX_FILES ||
    size > MAX_CONTENT_BYTES
  )
    throw new Error("Content bundle exceeds file or byte limit");
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/")))
        throw new Error("Content bundle file conflicts with directory");
      parts.pop();
    }
  }
  return files;
}

/** Stable ownership-free bytes: identical files share one R2 object and cache key. */
export async function prepareContentBundle(
  input: readonly ContentBundleFile[],
): Promise<{
  readonly descriptor: ContentBundle;
  readonly archive: Buffer;
}> {
  const files = validateFiles(input);
  const archive = await prepareCanonicalBundleArchive(files);
  const descriptor = contentBundleSchema.parse({
    sha256: contentBundleDigest(archive),
    archiveBytes: archive.length,
  });
  return { descriptor, archive };
}

/** Verify complete compressed bytes before admitting any extracted member. */
export function readContentBundle(
  archive: Buffer,
  reference: ContentBundle,
): readonly ContentBundleFile[] {
  contentBundleSchema.parse(reference);
  if (
    archive.length !== reference.archiveBytes ||
    contentBundleDigest(archive) !== reference.sha256
  )
    throw new Error("Content bundle integrity mismatch");
  const bytes = gunzipSync(archive, {
    maxOutputLength: MAX_CONTENT_BYTES + 2 * 1024 * 1024,
  });
  const files: ContentBundleFile[] = [];
  let failure: unknown;
  let expanded = 0;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      if (
        !["File", "OldFile"].includes(entry.type) ||
        entry.size > MAX_CONTENT_BYTES ||
        files.length >= MAX_FILES
      ) {
        failure = new Error("Invalid content bundle entry");
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        expanded += chunk.length;
        if (expanded > MAX_CONTENT_BYTES)
          failure = new Error("Content bundle exceeds byte limit");
        else chunks.push(chunk);
      });
      entry.on("end", () => {
        return files.push({
          path: entry.path,
          content: Buffer.concat(chunks),
          // The canonical writer defaults to 0600. Preserve explicit public or
          // executable modes when a shared package is republished by a copy.
          ...(entry.mode === 0o644 || entry.mode === 0o755
            ? { mode: entry.mode }
            : {}),
        });
      });
    },
  });
  parser.on("error", (error) => {
    failure = error;
  });
  parser.end(bytes);
  if (failure) throw failure;
  return validateFiles(files);
}
