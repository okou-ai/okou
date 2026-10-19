import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import { z } from "zod";

export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const filenames = ["CLAUDE.md", "AGENTS.md"] as const;
const manifestSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().min(0).max(MAX_EXPANDED_BYTES),
      }),
    )
    .max(100_000),
});

export function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/^\.\//, "");
  assert.ok(
    !normalized.startsWith("/") && !normalized.split("/").includes(".."),
    "unsafe_archive_path",
  );
  return normalized;
}

/** Preserve runtime bytes; editor/profile transformations do not belong here. */
export async function readContent(
  manifestBytes: Buffer,
  archive: Buffer,
  allowSingleFile: boolean,
): Promise<{ content: string; singleFile: boolean }> {
  assert.ok(manifestBytes.length <= MAX_MANIFEST_BYTES, "manifest_too_large");
  assert.ok(archive.length <= MAX_ARCHIVE_BYTES, "archive_too_large");
  const manifest = manifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const expected = new Map<string, { hash: string; size: number }>();
  for (const file of manifest.files) {
    const path = normalizedPath(file.path);
    if (
      filenames.some((filename) => {
        return filename === path;
      })
    ) {
      assert.ok(!expected.has(path), "duplicate_manifest_file");
      expected.set(path, file);
    }
  }
  assert.ok(expected.size > 0, "missing_instruction_files");
  const expanded = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.on("entry", (entry) => {
      try {
        const path = normalizedPath(entry.path);
        if (
          !filenames.some((filename) => {
            return filename === path;
          })
        ) {
          entry.resume();
          return;
        }
        assert.ok(!files.has(path), "duplicate_archive_file");
        assert.ok(
          entry.type === "File" || entry.type === "OldFile",
          "nonregular_instruction_file",
        );
        const metadata = expected.get(path);
        assert.ok(
          metadata && metadata.size === entry.size,
          "manifest_archive_mismatch",
        );
        // Reserve the name before reading to reject repeated entries.
        files.set(path, Buffer.alloc(0));
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => {
          return chunks.push(chunk);
        });
        entry.on("end", () => {
          return files.set(path, Buffer.concat(chunks));
        });
      } catch {
        reject(new Error("invalid_archive_entry"));
        entry.resume();
      }
    });
    parser.end(expanded);
  });
  assert.equal(files.size, expected.size, "missing_archive_file");
  const contents: string[] = [];
  for (const [path, bytes] of files) {
    const metadata = expected.get(path);
    assert.ok(
      metadata &&
        metadata.size === bytes.length &&
        metadata.hash === hash(bytes),
      "content_integrity_failed",
    );
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    assert.ok(!content.includes("\0"), "postgres_unrepresentable_text");
    contents.push(content);
  }
  const content = contents[0];
  assert.ok(content !== undefined, "missing_content");
  assert.ok(
    contents.every((candidate) => {
      return candidate === content;
    }),
    "divergent_framework_files",
  );
  const singleFile = files.size === 1;
  assert.ok(!singleFile || allowSingleFile, "single_file_requires_review");
  return { content, singleFile };
}
