import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { hash, readContent } from "./content";

function archiveFor(files: Readonly<Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), "instruction-content-"));
  try {
    const entries = Object.entries(files).map(([path, content]) => {
      writeFileSync(join(dir, path), content);
      return { path, size: Buffer.byteLength(content), hash: hash(content) };
    });
    const archive = join(dir, "archive.tar.gz");
    create(
      { cwd: dir, file: archive, gzip: true, sync: true },
      Object.keys(files),
    );
    return {
      manifest: Buffer.from(JSON.stringify({ files: entries })),
      archive: readFileSync(archive),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(["", "\uFEFF  指令\n[AGENT_PROFILE]\nraw\n\n"])(
  "preserves exact runtime text including empty files",
  async (content) => {
    const source = archiveFor({ "CLAUDE.md": content, "AGENTS.md": content });
    expect(await readContent(source.manifest, source.archive, false)).toEqual({
      content,
      singleFile: false,
    });
  },
);

it("rejects divergent framework files", async () => {
  const source = archiveFor({ "CLAUDE.md": "a", "AGENTS.md": "b" });
  await expect(
    readContent(source.manifest, source.archive, false),
  ).rejects.toThrow("divergent_framework_files");
});

it("requires review for a single-file layout", async () => {
  const source = archiveFor({ "AGENTS.md": "single" });
  await expect(
    readContent(source.manifest, source.archive, false),
  ).rejects.toThrow("single_file_requires_review");
  expect(await readContent(source.manifest, source.archive, true)).toEqual({
    content: "single",
    singleFile: true,
  });
});

it("rejects corrupted content even when the archive parses", async () => {
  const source = archiveFor({ "CLAUDE.md": "raw", "AGENTS.md": "raw" });
  const other = archiveFor({ "CLAUDE.md": "new", "AGENTS.md": "new" });
  await expect(
    readContent(source.manifest, other.archive, false),
  ).rejects.toThrow("content_integrity_failed");
});

it("does not turn a missing file or PostgreSQL NUL into empty text", async () => {
  const source = archiveFor({ "CLAUDE.md": "", "AGENTS.md": "" });
  const missing = archiveFor({ "other.md": "unrelated" });
  await expect(
    readContent(source.manifest, missing.archive, false),
  ).rejects.toThrow();
  const nul = archiveFor({ "CLAUDE.md": "\0", "AGENTS.md": "\0" });
  await expect(readContent(nul.manifest, nul.archive, false)).rejects.toThrow(
    "postgres_unrepresentable_text",
  );
});
