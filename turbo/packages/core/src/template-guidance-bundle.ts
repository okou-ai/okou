import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import {
  MAX_TEMPLATE_GUIDANCE_CONTENT_BYTES,
  MAX_TEMPLATE_GUIDANCE_FILES,
  MAX_TEMPLATE_GUIDANCE_FILE_BYTES,
  MAX_TEMPLATE_GUIDANCE_TAR_BYTES,
  templateGuidanceBundleSchema,
  type TemplateGuidanceBundle,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";
import { contentBundleDigest, type ContentBundleFile } from "./content-bundle";
import { prepareCanonicalBundleArchive } from "./content-bundle-archive";

function validateFiles(
  input: readonly ContentBundleFile[],
): readonly ContentBundleFile[] {
  if (input.length === 0 || input.length > MAX_TEMPLATE_GUIDANCE_FILES)
    throw new Error("Template guidance exceeds file limit");
  const files = [...input].sort((a, b) => {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    // These are the filesystem limits of the existing server-side publisher,
    // not the unrelated 256-character Workflow attachment limit.
    if (
      Buffer.byteLength(file.path) > 4095 ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      parts.some((part) => {
        return (
          !part ||
          part === "." ||
          part === ".." ||
          Buffer.byteLength(part) > 255
        );
      }) ||
      paths.has(file.path)
    )
      throw new Error("Invalid template guidance path");
    if (
      file.content.length > MAX_TEMPLATE_GUIDANCE_FILE_BYTES ||
      (file.mode !== undefined && file.mode !== 0o644)
    )
      throw new Error("Invalid template guidance file");
    paths.add(file.path);
    bytes += file.content.length;
  }
  if (bytes > MAX_TEMPLATE_GUIDANCE_CONTENT_BYTES)
    throw new Error("Template guidance exceeds content limit");
  for (const path of paths) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/")))
        throw new Error("Template guidance file conflicts with directory");
      parts.pop();
    }
  }
  return files;
}

export async function prepareTemplateGuidanceBundle(
  input: readonly ContentBundleFile[],
): Promise<{
  readonly descriptor: TemplateGuidanceBundle;
  readonly archive: Buffer;
}> {
  const files = validateFiles(input).map((file) => {
    return {
      ...file,
      mode: 0o644 as const,
    };
  });
  const archive = await prepareCanonicalBundleArchive(files);
  const descriptor = templateGuidanceBundleSchema.parse({
    sha256: contentBundleDigest(archive),
    archiveBytes: archive.length,
  });
  return { descriptor, archive };
}

/** Validate the compressed identity and the template profile before publication. */
export function readTemplateGuidanceBundle(
  archive: Buffer,
  reference: TemplateGuidanceBundle,
): readonly ContentBundleFile[] {
  templateGuidanceBundleSchema.parse(reference);
  if (
    archive.length !== reference.archiveBytes ||
    contentBundleDigest(archive) !== reference.sha256
  )
    throw new Error("Template guidance integrity mismatch");
  const bytes = gunzipSync(archive, {
    maxOutputLength: MAX_TEMPLATE_GUIDANCE_TAR_BYTES,
  });
  const files: ContentBundleFile[] = [];
  let failure: Error | undefined;
  let expanded = 0;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      if (
        !["File", "OldFile"].includes(entry.type) ||
        entry.size > MAX_TEMPLATE_GUIDANCE_FILE_BYTES ||
        files.length >= MAX_TEMPLATE_GUIDANCE_FILES ||
        entry.mode === undefined ||
        (entry.mode & 0o7777) !== 0o644
      ) {
        failure = new Error("Invalid template guidance entry");
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        expanded += chunk.length;
        if (expanded > MAX_TEMPLATE_GUIDANCE_CONTENT_BYTES)
          failure = new Error("Template guidance exceeds content limit");
        else chunks.push(chunk);
      });
      entry.on("end", () => {
        return files.push({
          path: entry.path,
          content: Buffer.concat(chunks),
          mode: 0o644,
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
