import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createArchive,
  inspectArchive,
  inspectTemplateDirectory,
  withExtractedArchive,
} from "./archive.mjs";
import {
  assertSameSet,
  assertSha256,
  buildFileManifest,
  COMMIT_PATTERN,
  computeVersionId,
  loadConfig,
  readJson,
  sha256,
  totalFileSize,
  writeLine,
} from "./shared.mjs";

async function sourceSlugs(sourceDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function buildPackage(sourceDir, outputDir, release) {
  const files = await buildFileManifest(sourceDir, release.slug);
  const versionId = computeVersionId(release.storageId, files);
  const archivePath = path.join(outputDir, `${release.slug}.tar.gz`);
  await createArchive(sourceDir, release.slug, archivePath);

  const archive = await readFile(archivePath);
  const archiveSha256 = sha256(archive);
  const inspected = await inspectArchive(archivePath, release, "new-build");
  writeLine(
    `VERIFIED build ${release.slug} version=${versionId} sha256=${archiveSha256} skillBytes=${inspected.skillBytes} colorSystems=${inspected.colorSystemCount}`,
  );

  return {
    slug: release.slug,
    resourceId: release.resourceId,
    storageId: release.storageId,
    versionId,
    archive: {
      path: `${release.slug}.tar.gz`,
      sha256: archiveSha256,
      byteSize: archive.byteLength,
    },
    totalSize: totalFileSize(files),
    fileCount: files.length,
    files,
    ...inspected,
  };
}

export async function buildBundle({ sourceDir, outputDir, sourceCommit }) {
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("--source-commit must be a full lowercase Git commit SHA");
  }

  const config = await loadConfig();
  assertSameSet(
    await sourceSlugs(sourceDir),
    config.templates.map((release) => release.slug),
    "Template source set",
  );
  await mkdir(outputDir, { recursive: true });

  const packages = [];
  for (const release of config.templates) {
    packages.push(await buildPackage(sourceDir, outputDir, release));
  }

  const publication = {
    schemaVersion: 1,
    source: { ...config.source, commit: sourceCommit },
    packages,
  };
  await writeFile(
    path.join(outputDir, "publication.json"),
    `${JSON.stringify(publication, null, 2)}\n`,
  );
  return publication;
}

function validatePublication(config, publication) {
  const sourceMatches =
    publication.source?.repository === config.source.repository &&
    publication.source?.ref === config.source.ref &&
    publication.source?.directory === config.source.directory;
  if (
    publication.schemaVersion !== 1 ||
    !sourceMatches ||
    !COMMIT_PATTERN.test(publication.source?.commit) ||
    !Array.isArray(publication.packages)
  ) {
    throw new Error(
      "Publication metadata does not match the current release inputs",
    );
  }
  assertSameSet(
    publication.packages.map((entry) => entry.slug),
    config.templates.map((release) => release.slug),
    "Publication template set",
  );
}

function validatePackageMetadata(pkg, release) {
  if (
    !pkg ||
    pkg.resourceId !== release.resourceId ||
    pkg.storageId !== release.storageId ||
    pkg.archive.path !== `${release.slug}.tar.gz`
  ) {
    throw new Error(`${release.slug}: publication metadata does not match`);
  }
  assertSha256(pkg.versionId, `${release.slug} publication version id`);
  assertSha256(pkg.archive.sha256, `${release.slug} publication sha256`);
}

function validateArchiveBytes(pkg, release, archive) {
  if (
    archive.byteLength !== pkg.archive.byteSize ||
    sha256(archive) !== pkg.archive.sha256
  ) {
    throw new Error(`${release.slug}: archive bytes do not match`);
  }
}

async function validateExtractedPackage(root, pkg, release) {
  const files = await buildFileManifest(root, release.slug);
  const versionId = computeVersionId(release.storageId, files);
  if (
    versionId !== pkg.versionId ||
    pkg.fileCount !== files.length ||
    pkg.totalSize !== totalFileSize(files) ||
    JSON.stringify(pkg.files) !== JSON.stringify(files)
  ) {
    throw new Error(`${release.slug}: extracted file manifest does not match`);
  }

  const inspected = await inspectTemplateDirectory(
    path.join(root, release.slug),
    release,
    "verified-bundle",
  );
  return { inspected, versionId };
}

async function verifyPackage(outputDir, pkg, release) {
  validatePackageMetadata(pkg, release);
  const archivePath = path.join(outputDir, pkg.archive.path);
  const archive = await readFile(archivePath);
  validateArchiveBytes(pkg, release, archive);

  const result = await withExtractedArchive(
    archivePath,
    `presentation-${release.slug}-verify-`,
    async (root) => {
      return await validateExtractedPackage(root, pkg, release);
    },
  );
  writeLine(
    `VERIFIED bundle ${release.slug} version=${result.versionId} sha256=${pkg.archive.sha256} skillBytes=${result.inspected.skillBytes} colorSystems=${result.inspected.colorSystemCount}`,
  );
}

export async function verifyBundle(outputDir) {
  const config = await loadConfig();
  const publication = await readJson(path.join(outputDir, "publication.json"));
  validatePublication(config, publication);

  const packagesBySlug = new Map(
    publication.packages.map((pkg) => [pkg.slug, pkg]),
  );
  for (const release of config.templates) {
    await verifyPackage(outputDir, packagesBySlug.get(release.slug), release);
  }
  return { config, publication };
}
