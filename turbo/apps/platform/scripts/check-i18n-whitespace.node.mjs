import console from "node:console";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const resourcesDirectory = fileURLToPath(
  new URL("../src/i18n/locales/", import.meta.url),
);
const clerkResourcesDirectory = fileURLToPath(
  new URL("../src/i18n/clerk-localizations/", import.meta.url),
);

/** Preserve deliberate spaces around translated rich-text fragments. */
export function findTranslationWhitespaceIssues(resource) {
  const issues = [];

  function visit(value, key) {
    for (const [part, entry] of Object.entries(value)) {
      const path = key ? `${key}.${part}` : part;
      if (typeof entry === "string") {
        if (/(?:\n|\\n)$/u.test(entry)) {
          issues.push(`${path}: trailing newline or literal \\n`);
        }
        if (/ {2,}/u.test(entry)) {
          issues.push(`${path}: repeated ASCII spaces`);
        }
      } else if (entry !== null && typeof entry === "object") {
        visit(entry, path);
      }
    }
  }

  visit(resource, "");
  return issues;
}

export function checkTranslationResources() {
  const issues = [];
  for (const locale of readdirSync(resourcesDirectory, {
    withFileTypes: true,
  })) {
    if (!locale.isDirectory()) {
      continue;
    }
    for (const namespace of ["common", "agents"]) {
      const resource = JSON.parse(
        readFileSync(
          join(resourcesDirectory, locale.name, `${namespace}.json`),
          "utf8",
        ),
      );
      for (const issue of findTranslationWhitespaceIssues(resource)) {
        issues.push(`${locale.name}/${namespace}.json ${issue}`);
      }
    }
  }
  for (const file of readdirSync(clerkResourcesDirectory)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const resource = JSON.parse(
      readFileSync(join(clerkResourcesDirectory, file), "utf8"),
    );
    for (const issue of findTranslationWhitespaceIssues(resource)) {
      issues.push(`clerk-localizations/${file} ${issue}`);
    }
  }
  return issues;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const issues = checkTranslationResources();
  if (issues.length > 0) {
    console.error(`Translation whitespace errors:\n${issues.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Translation whitespace check passed.");
  }
}
