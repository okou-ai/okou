import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const defaultAppRoot = path.resolve(path.dirname(scriptPath), "..");
const authV1Directory = "src/views/auth-v1";
const guidePath = "docs/clerk-customize.md";

function getForbiddenTextPatterns() {
  return [
    {
      pattern: /!\s*important\b/iu,
      reason: "uses !important",
    },
    {
      pattern: /(?:\.cl-[\w-]*|\bcl-internal-[\w-]*)/u,
      reason: "depends on a Clerk-owned class",
    },
    {
      pattern: /\[\s*class\s*(?:[*^$~|]?=)/iu,
      reason: "matches Clerk DOM through a class attribute selector",
    },
    {
      pattern: /\bdata-localization-key\b/iu,
      reason: "depends on Clerk's internal localization attribute",
    },
    {
      pattern: /:has\s*\(/iu,
      reason: "depends on Clerk's internal DOM structure through :has()",
    },
    {
      pattern: /\b(?:button|input)\s*\[\s*type\s*(?:[*^$~|]?=)/iu,
      reason: "targets a Clerk control by its rendered element structure",
    },
  ];
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  return null;
}

function stringValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => {
        return span.literal.text;
      }),
    ].join("{…}");
  }
  return null;
}

function jsxTagName(node, sourceFile) {
  if (ts.isJsxElement(node)) {
    return node.openingElement.tagName.getText(sourceFile);
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return node.tagName.getText(sourceFile);
  }
  return null;
}

function moduleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  return null;
}

function getCheckedFiles(appRoot = defaultAppRoot) {
  const checkedFiles = [];

  function collect(relativeDirectory) {
    const absoluteDirectory = path.join(appRoot, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") {
          collect(relativePath);
        }
        continue;
      }
      if (
        (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) &&
        !relativePath.endsWith(".test.ts") &&
        !relativePath.endsWith(".test.tsx")
      ) {
        checkedFiles.push(relativePath);
      }
    }
  }

  collect(authV1Directory);
  return checkedFiles.sort();
}

export function checkSource(relativePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];
  const recorded = new Set();
  const forbiddenTextPatterns = getForbiddenTextPatterns();

  function record(node, reason) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const violation = {
      column: position.character + 1,
      line: position.line + 1,
      reason,
    };
    const key = `${violation.line}:${violation.column}:${reason}`;
    if (!recorded.has(key)) {
      recorded.add(key);
      violations.push(violation);
    }
  }

  function checkElementsObject(node) {
    if (
      !ts.isPropertyAssignment(node) ||
      propertyName(node.name) !== "elements" ||
      !ts.isObjectLiteralExpression(node.initializer)
    ) {
      return;
    }
    for (const element of node.initializer.properties) {
      if (
        ts.isPropertyAssignment(element) &&
        ts.isObjectLiteralExpression(element.initializer)
      ) {
        record(
          element.initializer,
          "uses a CSS-in-JS object instead of Tailwind classes on a public Clerk element slot",
        );
      }
    }
  }

  function visit(node) {
    const value = stringValue(node);
    if (value !== null) {
      for (const { pattern, reason } of forbiddenTextPatterns) {
        if (pattern.test(value)) {
          record(node, reason);
        }
      }
    }

    const tagName = jsxTagName(node, sourceFile);
    if (tagName === "style") {
      record(node, "injects a raw <style> element");
    }

    if (ts.isJsxAttribute(node)) {
      const name = propertyName(node.name);
      if (name === "style") {
        record(node, "adds inline styles to the Clerk V1 implementation");
      }
      if (name === "dangerouslySetInnerHTML") {
        record(node, "can inject raw styles or Clerk DOM markup");
      }
    }

    const specifier = moduleSpecifier(node);
    if (specifier !== null && /\.css(?:\?.*)?$/iu.test(specifier)) {
      record(node, "imports a route-owned stylesheet");
    }

    if (
      relativePath === `${authV1Directory}/provider-appearance.ts` &&
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node)) &&
      propertyName(node.name) === "elements"
    ) {
      record(
        node,
        "adds element overrides at provider scope instead of the V1 auth component scope",
      );
    }

    checkElementsObject(node);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export function formatFailure(violations) {
  return `Clerk V1 customization lint failed.

Read ${guidePath} before changing Clerk styles. Use only the public Clerk
appearance contract described there; do not restore raw CSS or target
Clerk-owned DOM.

Violations:
${violations
  .map((violation) => {
    return `  - ${violation.relativePath}:${violation.line}:${violation.column} ${violation.reason}`;
  })
  .join("\n")}
`;
}

function main() {
  const appRoot = defaultAppRoot;
  const violations = getCheckedFiles(appRoot).flatMap((relativePath) => {
    const sourceText = readFileSync(path.join(appRoot, relativePath), "utf8");
    return checkSource(relativePath, sourceText).map((violation) => {
      return { relativePath, ...violation };
    });
  });

  if (violations.length > 0) {
    process.stderr.write(formatFailure(violations));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}
