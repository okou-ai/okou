import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as tar from "tar";

import { listFiles } from "./shared.mjs";

export async function createArchive(sourceDir, slug, archivePath) {
  await tar.create(
    {
      cwd: sourceDir,
      file: archivePath,
      gzip: true,
      noMtime: true,
      portable: true,
    },
    [slug],
  );
}

export async function withExtractedArchive(archivePath, prefix, operation) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await tar.extract({ file: archivePath, cwd: root, gzip: true });
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function requiredTemplateFiles(release) {
  return [
    "SKILL.md",
    "design-system.md",
    "layouts/shared-shell.html",
    `color-systems/${release.defaultColorSystem}.css`,
  ];
}

async function assertRequiredFiles(templateDir, release, label) {
  for (const relativePath of requiredTemplateFiles(release)) {
    const fileStat = await stat(path.join(templateDir, relativePath));
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new Error(
        `${release.slug} ${label}: ${relativePath} is missing or empty`,
      );
    }
  }
}

function colorReferences(contents) {
  return contents.matchAll(
    /(?<![\w/.-])((?:\.\.\/)*color-systems\/[\w.-]+\.css)/g,
  );
}

async function danglingColorReferences(templateDir, relativePaths) {
  const present = new Set(relativePaths);
  const dangling = [];

  for (const relativePath of relativePaths) {
    if (!/\.(md|html|css|js|sh)$/.test(relativePath)) {
      continue;
    }
    const contents = await readFile(
      path.join(templateDir, relativePath),
      "utf8",
    );
    for (const match of colorReferences(contents)) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativePath), match[1]),
      );
      if (target.startsWith("..") || !present.has(target)) {
        dangling.push(`${relativePath} -> ${match[1]}`);
      }
    }
  }
  return dangling;
}

export async function inspectTemplateDirectory(templateDir, release, label) {
  await assertRequiredFiles(templateDir, release, label);
  const skill = await readFile(path.join(templateDir, "SKILL.md"), "utf8");
  if (skill.length < 1024) {
    throw new Error(
      `${release.slug} ${label}: SKILL.md is too short to be guidance`,
    );
  }

  const relativePaths = await listFiles(templateDir);
  const dangling = await danglingColorReferences(templateDir, relativePaths);
  if (dangling.length > 0) {
    throw new Error(
      `${release.slug} ${label}: colour-system references do not resolve inside the package (${dangling.join(", ")})`,
    );
  }

  const colorSystemCount = relativePaths.filter((relativePath) => {
    return relativePath.startsWith("color-systems/");
  }).length;
  return { skillBytes: skill.length, colorSystemCount };
}

export async function inspectArchive(archivePath, release, label) {
  return await withExtractedArchive(
    archivePath,
    `presentation-${release.slug}-${label}-`,
    async (root) => {
      return await inspectTemplateDirectory(
        path.join(root, release.slug),
        release,
        label,
      );
    },
  );
}
