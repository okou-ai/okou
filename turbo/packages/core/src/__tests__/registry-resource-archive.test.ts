import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { describe, expect, it } from "vitest";
import {
  inspectRegistryResourceArchive,
  registryResourceArchiveKey,
} from "../registry-resource-archive";

describe("published registry archives", () => {
  it("preserves original bytes and harmless parent directories within the package boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "registry-archive-test-"));
    const sourcePath = "illustration-template/package";
    try {
      await mkdir(join(root, sourcePath, "assets"), { recursive: true });
      await writeFile(join(root, sourcePath, "SKILL.md"), "Guide\r\n正文");
      await writeFile(
        join(root, sourcePath, "assets/raw.bin"),
        Buffer.from([0, 255]),
      );
      const path = join(root, "archive.tar.gz");
      await create({ cwd: root, file: path, gzip: true }, [
        "illustration-template",
      ]);
      const archive = await readFile(path);
      const original = Buffer.from(archive);
      const sha256 = createHash("sha256").update(archive).digest("hex");
      const inspected = inspectRegistryResourceArchive(
        archive,
        sha256,
        sourcePath,
      );
      expect(inspected).toEqual({
        descriptor: {
          format: "registry-tar-gzip-v1",
          sha256,
          archiveBytes: archive.length,
        },
        fileCount: 2,
        totalBytes: Buffer.byteLength("Guide\r\n正文") + 2,
      });
      expect(archive.equals(original)).toBe(true);
      expect(registryResourceArchiveKey(sha256)).toBe(
        `registry-archives/v1/${sha256}.tar.gz`,
      );
      await writeFile(
        join(root, "illustration-template/outside.md"),
        "outside",
      );
      await create({ cwd: root, file: path, gzip: true }, [
        "illustration-template",
      ]);
      const outside = await readFile(path);
      expect(() => {
        return inspectRegistryResourceArchive(outside, undefined, sourcePath);
      }).toThrow("outside its package");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or ambiguous extraction even when compressed bytes match", async () => {
    const root = await mkdtemp(join(tmpdir(), "registry-archive-test-"));
    try {
      await mkdir(join(root, "package"));
      await writeFile(join(root, "package/SKILL.md"), "Guide");
      await symlink("../../outside", join(root, "package/link"));
      const path = join(root, "archive.tar.gz");
      await create({ cwd: root, file: path, gzip: true }, ["package"]);
      const linked = await readFile(path);
      expect(() => {
        return inspectRegistryResourceArchive(linked, undefined, "package");
      }).toThrow("Unsupported registry archive entry");
      await rm(join(root, "package/link"));
      await create({ cwd: root, file: path, gzip: true }, [
        "package",
        "package/SKILL.md",
      ]);
      const duplicated = await readFile(path);
      expect(() => {
        return inspectRegistryResourceArchive(duplicated, undefined, "package");
      }).toThrow("duplicated");
      expect(() => {
        return inspectRegistryResourceArchive(
          duplicated,
          "0".repeat(64),
          "package",
        );
      }).toThrow("digest mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
