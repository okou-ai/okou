import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { create, Parser } from "tar";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import { workflowAttachmentPath } from "./workflow-attachment-bundle";

export interface ContentBundleFile {
  readonly path: string;
  readonly content: Buffer;
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
  const root = await mkdtemp(join(tmpdir(), "content-bundle-"));
  try {
    const directory = join(root, "files");
    for (const file of files) {
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { mode: 0o600 });
    }
    const archivePath = join(root, "archive.tar.gz");
    await create(
      {
        cwd: directory,
        file: archivePath,
        gzip: { portable: true },
        portable: true,
        mtime: new Date(0),
        noDirRecurse: true,
      },
      files.map((file) => {
        return file.path;
      }),
    );
    const archive = await readFile(archivePath);
    const descriptor = contentBundleSchema.parse({
      sha256: contentBundleDigest(archive),
      archiveBytes: archive.length,
    });
    return { descriptor, archive };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
        return files.push({ path: entry.path, content: Buffer.concat(chunks) });
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
