import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const CONFIG_URL = new URL(
  "../presentation-template-release.json",
  import.meta.url,
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function assertSameSet(actual, expected, label) {
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
    throw new Error(`${label} mismatch: ${JSON.stringify(sorted(actual))}`);
  }
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}

export function assertSha256(value, label) {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateConfigShape(config) {
  if (
    config.schemaVersion !== 1 ||
    config.source?.repository !== "maxandzoe/Template-artifact" ||
    config.source?.ref !== "main" ||
    config.source?.directory !== "Template-Presentation" ||
    !Array.isArray(config.templates) ||
    config.templates.length === 0
  ) {
    throw new Error("Presentation release configuration is invalid");
  }
}

function validateRelease(release) {
  const valid =
    typeof release.slug === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(release.slug) &&
    typeof release.resourceId === "string" &&
    /^template:html-ppt-[a-z0-9]+(?:-[a-z0-9]+)*-runbook$/.test(
      release.resourceId,
    ) &&
    typeof release.defaultColorSystem === "string" &&
    /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(release.defaultColorSystem) &&
    typeof release.storageId === "string" &&
    /^[0-9a-f-]{36}$/.test(release.storageId);

  if (!valid) {
    throw new Error(`${release.slug ?? "unknown"}: invalid release metadata`);
  }
}

export async function loadConfig() {
  const config = await readJson(CONFIG_URL);
  validateConfigShape(config);
  assertUnique(
    config.templates.map((release) => release.slug),
    "Template slugs",
  );
  assertUnique(
    config.templates.map((release) => release.resourceId),
    "Template resource ids",
  );
  assertUnique(
    config.templates.map((release) => release.storageId),
    "Template storage ids",
  );
  config.templates.forEach(validateRelease);
  return config;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeVersionId(storageId, files) {
  const entries = files.map((file) => `${file.path}:${file.hash}`).sort();
  return sha256(`storage:${storageId}\n${entries.join("\n")}`);
}

export async function listFiles(rootDir, relativeDir = "") {
  const entries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries.sort((left, right) => {
    return left.name.localeCompare(right.name);
  })) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported template entry: ${relativePath}`);
    }
  }
  return files;
}

export async function buildFileManifest(sourceDir, slug) {
  const templateDir = path.join(sourceDir, slug);
  const relativePaths = await listFiles(templateDir);
  return await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(templateDir, relativePath);
      const [contents, fileStat] = await Promise.all([
        readFile(filePath),
        stat(filePath),
      ]);
      return {
        path: path.posix.join(slug, relativePath),
        hash: sha256(contents),
        size: fileStat.size,
      };
    }),
  );
}

export function totalFileSize(files) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

export function writeLine(message) {
  process.stdout.write(`${message}\n`);
}
