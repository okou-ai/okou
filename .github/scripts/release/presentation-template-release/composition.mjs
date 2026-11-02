import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSameSet,
  buildFileManifest,
  listFiles,
  readJson,
} from "./shared.mjs";

const TEMPLATE_MARKER = "presentation-template.json";
const PACKAGE_MARKER = "presentation-package.json";
const TEMPLATE_CONTRACT = {
  version: 1,
  runtime: "external",
  styleGuide: "SKILL.md",
};
const PACKAGE_CONTRACT = {
  version: 1,
  template: "template",
  runtime: "presentation",
};
const REQUIRED_RUNTIME_FILES = [
  "SKILL.md",
  "start.py",
  "tools/bootstrap.py",
  "tools/runtime.py",
  "tools/prepare.py",
  "tools/delivery.py",
  "tools/run.sh",
  "tools/audit.js",
  "parallel/tools/pipeline.py",
  "parallel/tools/page_queue.py",
  "parallel/worker.md",
  "parallel/worker-handoff.md",
  "html-authoring.md",
];

export async function assertDirectory(directory) {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(`Expected a regular template directory: ${directory}`);
  }
}

async function assertContract(directory, filename, expected) {
  if (!(await lstat(path.join(directory, filename))).isFile()) {
    throw new Error(`${directory}: invalid ${filename}`);
  }
  const contents = await readFile(path.join(directory, filename), "utf8");
  const actual = JSON.parse(contents);
  if (
    !isObject(actual) ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value) ||
    // Both contracts are flat, with exact scalar values. Count their raw keys
    // too, so duplicate keys cannot disappear during JSON.parse.
    [...contents.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].length !==
      Object.keys(expected).length
  ) {
    throw new Error(`${directory}: invalid ${filename}`);
  }
}

export async function hasExternalTemplateContract(templateDir) {
  if (!(await readdir(templateDir)).includes(TEMPLATE_MARKER)) {
    return false;
  }
  await assertContract(templateDir, TEMPLATE_MARKER, TEMPLATE_CONTRACT);
  return true;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCache(relativePath) {
  return (
    relativePath
      .split("/")
      .some((part) => ["__pycache__", ".pytest_cache"].includes(part)) ||
    /\.py[co]$/.test(relativePath)
  );
}

async function assertSourceLayout(directory, role, relativeDir = "") {
  const entries = await readdir(path.join(directory, relativeDir), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (
      [TEMPLATE_MARKER, PACKAGE_MARKER].includes(entry.name) &&
      !(
        role === "template" &&
        relativePath === TEMPLATE_MARKER &&
        entry.isFile()
      )
    ) {
      throw new Error(`${directory}: invalid metadata entry ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (
        ["presentation", "presentation-parallel"].includes(entry.name) ||
        (entry.name === "parallel" &&
          !(role === "runtime" && relativePath === "parallel"))
      ) {
        throw new Error(
          `${directory}: mixed or nested runtime directory ${relativePath}`,
        );
      }
      await assertSourceLayout(directory, role, relativePath);
    }
  }
}

async function assertExternalTemplate(templateDir) {
  if (!(await hasExternalTemplateContract(templateDir))) {
    throw new Error(`${templateDir}: missing external ${TEMPLATE_MARKER}`);
  }
  const qaConfig = path.join(templateDir, "qa-config.json");
  if (
    !(await lstat(qaConfig)).isFile() ||
    !isObject(await readJson(qaConfig))
  ) {
    throw new Error(
      `${templateDir}: invalid qa-config.json (expected an object)`,
    );
  }
  await assertSourceLayout(templateDir, "template");
}

async function assertRuntime(runtimeDir, files) {
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (
      !files.includes(required) ||
      (await lstat(path.join(runtimeDir, required))).size === 0
    ) {
      throw new Error(
        `${runtimeDir}: missing or empty runtime file ${required}`,
      );
    }
  }
  await assertSourceLayout(runtimeDir, "runtime");
}

function markdownReferences(contents, replace) {
  const replaceTarget = (_match, prefix, destination) => {
    const angled = destination.startsWith("<");
    const target = angled ? destination.slice(1, -1) : destination;
    const rewritten = replace(target);
    return `${prefix}${angled ? `<${rewritten}>` : rewritten}`;
  };
  return contents
    .replace(
      /(\]\(\s*)(<[^>\n]+>|(?:[^\s()<>]|\([^()\n]*\))+)(?=\s*(?:["'][^\n]*["']\s*)?\))/g,
      replaceTarget,
    )
    .replace(
      /^( {0,3}\[[^\]\n]+\]:\s*)(<[^>\n]+>|[^\s]+)(?=\s|$)/gm,
      replaceTarget,
    );
}

function localMarkdownPath(target) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) {
    return undefined;
  }
  return path.posix.normalize(decodeURIComponent(target.split(/[?#]/, 1)[0]));
}

export function composePackageSkill(runtimeSkill) {
  const rewritten = markdownReferences(runtimeSkill, (target) => {
    const localPath = localMarkdownPath(target);
    if (localPath === undefined) {
      return target;
    }
    if (
      localPath === ".." ||
      localPath.startsWith("../") ||
      localPath.includes("\\")
    ) {
      throw new Error(
        `Runtime SKILL.md reference escapes its directory: ${target}`,
      );
    }
    return `presentation/${target.replace(/^\.\//, "")}`;
  });
  const frontmatter =
    rewritten.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
  const banner = `\n## Downloaded package bindings\n\nThis entrypoint is generated from [the common runtime guide](presentation/SKILL.md), not a separately maintained workflow. Resolve \`PACKAGE\` to the absolute directory containing this file, then bind:\n\n- \`RUNTIME=PACKAGE/presentation\`\n- \`TEMPLATE=PACKAGE/template\`\n- \`TASK\` to a new, separate workspace outside \`PACKAGE\` (never inside either source directory).\n\nUse these bindings throughout the shared workflow below. Unqualified workflow guide paths in prose refer to RUNTIME. The selected visual guide is [TEMPLATE/SKILL.md](template/SKILL.md).\n\n`;
  return `${frontmatter}${banner}${rewritten.slice(frontmatter.length)}`;
}

function assertMarkdownReferences(contents, files) {
  const present = new Set(files);
  markdownReferences(contents, (target) => {
    const localPath = localMarkdownPath(target);
    if (
      localPath !== undefined &&
      !present.has(localPath) &&
      !files.some((file) => file.startsWith(`${localPath.replace(/\/$/, "")}/`))
    ) {
      throw new Error(`Package SKILL.md reference does not resolve: ${target}`);
    }
    return target;
  });
}

export async function validateComposedDirectory(packageDir, files) {
  await assertContract(packageDir, PACKAGE_MARKER, PACKAGE_CONTRACT);
  assertSameSet(
    await readdir(packageDir),
    ["SKILL.md", PACKAGE_MARKER, "template", "presentation"],
    "Composed package layout",
  );
  const templateDir = path.join(packageDir, "template");
  const runtimeDir = path.join(packageDir, "presentation");
  await assertDirectory(templateDir);
  await assertDirectory(runtimeDir);
  await assertExternalTemplate(templateDir);
  await assertRuntime(runtimeDir, await listFiles(runtimeDir));
  if (files.some(isCache)) {
    throw new Error(`${packageDir}: composed package contains cache files`);
  }
  const rootSkill = await readFile(path.join(packageDir, "SKILL.md"), "utf8");
  const runtimeSkill = await readFile(
    path.join(runtimeDir, "SKILL.md"),
    "utf8",
  );
  if (rootSkill !== composePackageSkill(runtimeSkill)) {
    throw new Error(
      `${packageDir}: root SKILL.md does not match the bound runtime guide`,
    );
  }
  assertMarkdownReferences(rootSkill, files);
}

async function snapshot(sourceDir, name) {
  await assertDirectory(path.join(sourceDir, name));
  return (await buildFileManifest(sourceDir, name)).map((file) => ({
    ...file,
    path: file.path.slice(name.length + 1),
  }));
}

function assertSnapshot(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: files changed during package composition`);
  }
}

async function copySnapshot(sourceDir, targetDir, files) {
  await mkdir(targetDir, { recursive: true });
  for (const file of files) {
    await mkdir(path.dirname(path.join(targetDir, file.path)), {
      recursive: true,
    });
    await copyFile(
      path.join(sourceDir, file.path),
      path.join(targetDir, file.path),
    );
  }
}

export async function withPackageSource(sourceDir, slug, operation) {
  const templateDir = path.join(sourceDir, slug);
  await assertDirectory(templateDir);
  if ((await readdir(templateDir)).includes(PACKAGE_MARKER)) {
    throw new Error(
      `${templateDir}: source must be a visual template, not a composed package`,
    );
  }
  if (!(await hasExternalTemplateContract(templateDir))) {
    return await operation(sourceDir);
  }
  await assertExternalTemplate(templateDir);
  const originalTemplate = await snapshot(sourceDir, slug);
  const sourceRepo = path.dirname(sourceDir);
  await assertDirectory(sourceRepo);
  const runtimeDir = path.join(sourceRepo, "presentation");
  const originalRuntime = await snapshot(sourceRepo, "presentation");
  await assertRuntime(
    runtimeDir,
    originalRuntime.map((file) => file.path),
  );
  const stagingDir = await mkdtemp(
    path.join(tmpdir(), `presentation-${slug}-compose-`),
  );
  try {
    const packageDir = path.join(stagingDir, slug);
    const templateFiles = originalTemplate.filter(
      (file) => !isCache(file.path),
    );
    const runtimeFiles = originalRuntime.filter((file) => !isCache(file.path));
    await copySnapshot(
      templateDir,
      path.join(packageDir, "template"),
      templateFiles,
    );
    await copySnapshot(
      runtimeDir,
      path.join(packageDir, "presentation"),
      runtimeFiles,
    );
    assertSnapshot(
      await snapshot(packageDir, "template"),
      templateFiles,
      "Copied visual template",
    );
    assertSnapshot(
      await snapshot(packageDir, "presentation"),
      runtimeFiles,
      "Copied runtime",
    );
    const runtimeSkill = await readFile(
      path.join(packageDir, "presentation/SKILL.md"),
      "utf8",
    );
    await writeFile(
      path.join(packageDir, "SKILL.md"),
      composePackageSkill(runtimeSkill),
    );
    await writeFile(
      path.join(packageDir, PACKAGE_MARKER),
      `${JSON.stringify(PACKAGE_CONTRACT, null, 2)}\n`,
    );
    await validateComposedDirectory(packageDir, await listFiles(packageDir));
    const finalPackage = await snapshot(stagingDir, slug);
    const assertSourcesUnchanged = async () => {
      assertSnapshot(
        await snapshot(sourceDir, slug),
        originalTemplate,
        "Source visual template",
      );
      assertSnapshot(
        await snapshot(sourceRepo, "presentation"),
        originalRuntime,
        "Source runtime",
      );
      await assertSourceLayout(templateDir, "template");
      await assertSourceLayout(runtimeDir, "runtime");
    };
    await assertSourcesUnchanged();
    const result = await operation(stagingDir);
    assertSnapshot(
      await snapshot(stagingDir, slug),
      finalPackage,
      "Staged package",
    );
    await assertSourcesUnchanged();
    return result;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
