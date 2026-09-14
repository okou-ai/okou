#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import ts from "typescript";

const canonicalName = "tsconfig.tests.json";
export const testProjectNames = [
  ".typecheck/tsconfig.tests-0.json",
  ".typecheck/tsconfig.tests-1.json",
];

function normalized(path) {
  return path.replaceAll("\\", "/");
}

function parseConfig(root, name, config) {
  const path = resolve(root, name);
  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `${name}: ${parsed.errors
        .map((error) => {
          return ts.flattenDiagnosticMessageText(error.messageText, "\n");
        })
        .join("\n")}`,
    );
  }
  return parsed;
}

function readConfig(root, name) {
  const result = ts.readConfigFile(resolve(root, name), ts.sys.readFile);
  if (result.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(result.error.messageText, "\n"),
    );
  }
  return parseConfig(root, name, result.config);
}

function expectedProjects(root) {
  const canonical = readConfig(root, canonicalName);
  if (!canonical.options.rootDir || !canonical.projectReferences?.length) {
    throw new Error(
      "Canonical tests require rootDir and explicit project references",
    );
  }
  const files = canonical.fileNames
    .map((path) => {
      return normalized(relative(root, path));
    })
    .sort();
  if (new Set(files).size !== files.length) {
    throw new Error("Duplicate canonical test roots");
  }
  if (canonical.raw.files) {
    const explicit = canonical.raw.files.map((path) => {
      return resolve(root, normalized(path));
    });
    if (new Set(explicit).size !== explicit.length) {
      throw new Error("Duplicate explicit canonical test roots");
    }
  }
  for (const file of files) {
    if (!fs.statSync(resolve(root, file)).isFile()) {
      throw new Error(`Test root is not a file: ${file}`);
    }
  }
  const groups = [[], []];
  for (const file of files) {
    groups[createHash("sha256").update(file).digest()[0] % 2].push(file);
  }
  const projects = testProjectNames.map((name, index) => {
    const directory = dirname(resolve(root, name));
    const rebase = (path) => {
      return normalized(relative(directory, path));
    };
    const config = {
      extends: rebase(resolve(root, canonicalName)),
      compilerOptions: {
        rootDir: rebase(canonical.options.rootDir),
        tsBuildInfoFile: `./tests-${index}.tsbuildinfo`,
      },
      files: groups[index].map((path) => {
        return rebase(resolve(root, path));
      }),
      include: [],
      // Project references are not inherited through extends.
      references: canonical.raw.references.map((reference, referenceIndex) => {
        return {
          ...reference,
          path: rebase(canonical.projectReferences[referenceIndex].path),
        };
      }),
    };
    const parsed = parseConfig(root, name, config);
    return { name, parsed, content: `${JSON.stringify(config, null, 2)}\n` };
  });
  const actual = projects
    .flatMap(({ parsed }) => {
      return parsed.fileNames;
    })
    .sort();
  const expected = canonical.fileNames.toSorted();
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((file, index) => {
      return file !== expected[index];
    })
  ) {
    throw new Error(
      "Generated tests must own every canonical root exactly once",
    );
  }
  return projects;
}

export function validateTestProjects(root) {
  const projects = expectedProjects(root);
  for (const { name, content } of projects) {
    if (fs.readFileSync(resolve(root, name), "utf8") !== content) {
      throw new Error(
        `Stale or modified test project: ${name}; run scripts/prepare-typecheck-tests.mjs`,
      );
    }
    readConfig(root, name);
  }
}

export function prepareTestProjects(root) {
  const projects = expectedProjects(root);
  fs.mkdirSync(resolve(root, ".typecheck"), { recursive: true });
  for (const { name, content } of projects) {
    const path = resolve(root, name);
    if (fs.existsSync(path) && fs.readFileSync(path, "utf8") === content) {
      continue;
    }
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, content);
      fs.renameSync(temporary, path);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  validateTestProjects(root);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareTestProjects(resolve(import.meta.dirname, ".."));
}
