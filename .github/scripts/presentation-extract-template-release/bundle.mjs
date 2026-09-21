import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as tar from "tar";

import {
  createArchive,
  withExtractedArchive,
} from "../presentation-template-release/archive.mjs";
import {
  buildFileManifest,
  computeVersionId,
  readJson,
  sha256,
  totalFileSize,
} from "../presentation-template-release/shared.mjs";

export const release = await readJson(
  new URL("./release.json", import.meta.url),
);
const ARCHIVE_FILE = "presentation-extract-template.tar.gz";
const PUBLICATION_FILE = "publication.json";

function publicationFor(files, archive) {
  const versionId = computeVersionId(release.storageId, files);
  if (versionId !== release.versionId) {
    throw new Error("File manifest does not match the pinned source version.");
  }
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== release.archiveSha256) {
    throw new Error("Archive bytes do not match the pinned archive SHA-256.");
  }
  return {
    schemaVersion: 1,
    source: release.source,
    resourceId: release.resourceId,
    storageId: release.storageId,
    versionId,
    archive: {
      path: ARCHIVE_FILE,
      sha256: archiveSha256,
      byteSize: archive.byteLength,
    },
    totalSize: totalFileSize(files),
    fileCount: files.length,
    files,
  };
}

export function storageManifest(publication) {
  return {
    version: publication.versionId,
    // Pin the source timestamp so independently prepared bundles have identical
    // immutable manifest bytes. Database created_at records publication time.
    createdAt: release.source.committedAt,
    totalSize: publication.totalSize,
    fileCount: publication.fileCount,
    files: publication.files,
  };
}

export async function prepareBundle(sourceArchive, outputDir) {
  const source = await readFile(sourceArchive);
  if (sha256(source) !== release.source.archiveSha256) {
    throw new Error("Source archive does not match the pinned source SHA-256.");
  }
  const root = await mkdtemp(path.join(tmpdir(), "extract-template-prepare-"));
  try {
    const guide = path.join(root, release.directory);
    await mkdir(guide);
    // The digest above pins the trusted contents-only Git source archive.
    const verifiedSource = path.join(root, "source.tar.gz");
    await writeFile(verifiedSource, source);
    await tar.extract({ file: verifiedSource, cwd: guide, gzip: true });
    const files = await buildFileManifest(root, release.directory);
    await Promise.all([
      chmod(guide, 0o755),
      chmod(path.join(guide, "scripts"), 0o755),
      ...files.map((file) => chmod(path.join(root, file.path), 0o644)),
    ]);
    await mkdir(outputDir, { recursive: true });
    const archivePath = path.join(outputDir, ARCHIVE_FILE);
    await createArchive(root, release.directory, archivePath);
    const publication = publicationFor(files, await readFile(archivePath));
    await writeFile(
      path.join(outputDir, PUBLICATION_FILE),
      `${JSON.stringify(publication, null, 2)}\n`,
    );
    await writeFile(
      path.join(outputDir, "manifest.json"),
      `${JSON.stringify(storageManifest(publication))}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function verifyBundle(outputDir) {
  const archivePath = path.join(outputDir, ARCHIVE_FILE);
  const archive = await readFile(archivePath);
  // Check pinned bytes before extracting or trusting publication metadata.
  if (sha256(archive) !== release.archiveSha256) {
    throw new Error("Archive bytes do not match the pinned archive SHA-256.");
  }
  return await withExtractedArchive(
    archivePath,
    "extract-template-verify-",
    async (root) => {
      const files = await buildFileManifest(root, release.directory);
      const expected = publicationFor(files, archive);
      assert.deepEqual(
        await readJson(path.join(outputDir, PUBLICATION_FILE)),
        expected,
        "Publication metadata does not match the pinned package.",
      );
      assert.equal(
        await readFile(path.join(outputDir, "manifest.json"), "utf8"),
        `${JSON.stringify(storageManifest(expected))}\n`,
        "Storage manifest does not match the pinned package.",
      );
      return expected;
    },
  );
}
