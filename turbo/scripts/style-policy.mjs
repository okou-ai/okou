import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { fork } from "@eslint/css-tree";
import { tailwind4 } from "tailwind-csstree";
import ts from "typescript";

import { collectClassUsages } from "./style-class-usage.mjs";

const STYLE_POLICY_VERSION = 1;
const PROJECT_ROOT = process.cwd();
const ALLOWLIST_PATH = resolve(PROJECT_ROOT, "style-allowlist.json");
const CSS_GLOBS = ["apps/platform/src/**/*.css", "packages/ui/src/**/*.css"];
const SOURCE_GLOBS = [
  "apps/platform/src/**/*.ts",
  "apps/platform/src/**/*.tsx",
  "packages/ui/src/**/*.ts",
  "packages/ui/src/**/*.tsx",
];
const cssSyntax = fork(tailwind4);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedCode(value) {
  return value.replace(/\s+/g, " ").trim();
}

function atRuleName(node) {
  const prelude =
    node.prelude === null ? "" : ` ${cssSyntax.generate(node.prelude)}`;
  return `@${node.name}${prelude}`;
}

function selectorKey(record) {
  return JSON.stringify([
    record.file,
    record.atRules,
    record.parentSelectors ?? [],
    record.selector,
  ]);
}

function cssAtomKey(record) {
  return JSON.stringify([
    record.atRules,
    record.parentSelectors ?? [],
    record.selector,
    record.property,
    record.value,
    record.important,
  ]);
}

function injectionKey(record) {
  return JSON.stringify([
    record.file,
    record.syntax ?? record.kind,
    record.fingerprint,
  ]);
}

function metadataErrors(entry, label) {
  const errors = [];
  for (const field of ["owner", "rationale", "removal"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      errors.push(`${label} must have a non-empty ${field}`);
    }
  }
  if (
    entry.kind !== "global-environment" &&
    entry.kind !== "third-party-dom-adapter"
  ) {
    errors.push(
      `${label} kind must be global-environment or third-party-dom-adapter`,
    );
  }
  if (
    entry.kind === "third-party-dom-adapter" &&
    (typeof entry.upstream !== "string" || entry.upstream.trim() === "")
  ) {
    errors.push(`${label} must name its upstream DOM owner`);
  }
  return errors;
}

export function validatePolicyFiles(allowlist) {
  const errors = [];
  if (allowlist.version !== STYLE_POLICY_VERSION) {
    errors.push(`style-allowlist.json version must be ${STYLE_POLICY_VERSION}`);
  }

  const selectorKeys = new Set();
  for (const [index, entry] of allowlist.selectors.entries()) {
    const label = `selectors[${index}]`;
    errors.push(...metadataErrors(entry, label));
    if (
      typeof entry.file !== "string" ||
      !Array.isArray(entry.atRules) ||
      !entry.atRules.every((atRule) => typeof atRule === "string") ||
      typeof entry.selector !== "string"
    ) {
      errors.push(
        `${label} must have exact file, atRules, and selector fields`,
      );
      continue;
    }
    const key = selectorKey(entry);
    if (selectorKeys.has(key)) {
      errors.push(`${label} duplicates an existing selector allowlist entry`);
    }
    selectorKeys.add(key);
  }

  const injectionKeys = new Set();
  for (const [index, entry] of allowlist.styleInjections.entries()) {
    const label = `styleInjections[${index}]`;
    errors.push(...metadataErrors(entry, label));
    if (
      typeof entry.file !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
      typeof entry.syntax !== "string" ||
      typeof entry.preview !== "string"
    ) {
      errors.push(
        `${label} must have exact file, syntax, fingerprint, and preview fields`,
      );
      continue;
    }
    const key = injectionKey(entry);
    if (injectionKeys.has(key)) {
      errors.push(`${label} duplicates an existing style injection entry`);
    }
    injectionKeys.add(key);
  }

  const classDependencyKeys = new Set();
  for (const [index, entry] of allowlist.classDependencies.entries()) {
    const label = `classDependencies[${index}]`;
    errors.push(...metadataErrors(entry, label));
    if (
      typeof entry.file !== "string" ||
      typeof entry.token !== "string" ||
      entry.token.trim() === "" ||
      !Number.isSafeInteger(entry.count) ||
      entry.count <= 0
    ) {
      errors.push(
        `${label} must have exact file, token, and a positive integer count`,
      );
      continue;
    }
    const key = `${entry.file}\u0000${entry.token}`;
    if (classDependencyKeys.has(key)) {
      errors.push(`${label} duplicates an existing class dependency entry`);
    }
    classDependencyKeys.add(key);
  }

  const vendorFiles = new Set();
  for (const [index, entry] of allowlist.vendorFiles.entries()) {
    const label = `vendorFiles[${index}]`;
    if (
      typeof entry.file !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.owner !== "string" ||
      entry.owner.trim() === "" ||
      typeof entry.upstream !== "string" ||
      entry.upstream.trim() === "" ||
      typeof entry.rationale !== "string" ||
      entry.rationale.trim() === "" ||
      typeof entry.removal !== "string" ||
      entry.removal.trim() === ""
    ) {
      errors.push(
        `${label} must have exact file, sha256, owner, upstream, rationale, and removal fields`,
      );
    }
    if (vendorFiles.has(entry.file)) {
      errors.push(`${label} duplicates an existing vendored file entry`);
    }
    vendorFiles.add(entry.file);
  }

  return errors;
}

function blockDeclarations(block) {
  const declarations = [];
  block.children.forEach((child) => {
    if (child.type === "Declaration") {
      declarations.push({
        property: child.property,
        value: cssSyntax.generate(child.value),
        important: child.important,
      });
    } else if (child.type === "Atrule" && child.block === null) {
      declarations.push({
        property: `@${child.name}`,
        value: child.prelude === null ? "" : cssSyntax.generate(child.prelude),
        important: false,
      });
    }
  });
  return declarations;
}

function hasClassSelector(prelude) {
  let found = false;
  if (prelude !== null) {
    cssSyntax.walk(prelude, (node) => {
      if (node.type === "ClassSelector") {
        found = true;
      }
    });
  }
  return found;
}

function isScopeRule(node) {
  return node.type === "Atrule" && node.name.toLowerCase() === "scope";
}

function collectCssClassRules(file, text) {
  const ast = cssSyntax.parse(text, { filename: file, positions: true });
  const atRules = [];
  const selectors = [];
  const records = [];

  function recordBlock(node, includeEmpty) {
    if (!selectors.some(({ hasClass }) => hasClass)) {
      return;
    }
    const declarations = blockDeclarations(node.block);
    if (declarations.length === 0) {
      if (!includeEmpty) {
        return;
      }
      declarations.push({ property: null, value: null, important: false });
    }
    const parentSelectors = selectors
      .slice(0, -1)
      .map(({ selector }) => selector);
    records.push({
      file,
      atRules: [...atRules],
      ...(parentSelectors.length > 0 ? { parentSelectors } : {}),
      selector: selectors.at(-1).selector,
      declarations,
      line: node.loc.start.line,
    });
  }

  cssSyntax.walk(ast, {
    enter(node) {
      if (node.type === "Atrule") {
        atRules.push(atRuleName(node));
        if (isScopeRule(node)) {
          // Scope roots and limits qualify every descendant declaration,
          // including :scope, &, and type selectors with no class of their own.
          selectors.push({
            selector: atRuleName(node),
            hasClass: hasClassSelector(node.prelude),
          });
        }
        if (node.block !== null) {
          recordBlock(node, false);
        }
        return;
      }
      if (node.type !== "Rule") {
        return;
      }

      selectors.push({
        selector: cssSyntax.generate(node.prelude),
        hasClass: hasClassSelector(node.prelude),
      });
      recordBlock(node, true);
    },
    leave(node) {
      if (node.type === "Atrule") {
        if (isScopeRule(node)) {
          selectors.pop();
        }
        atRules.pop();
      } else if (node.type === "Rule") {
        selectors.pop();
      }
    },
  });

  return records;
}

function cssAtomsForRule(rule) {
  return rule.declarations.map((declaration) => {
    return {
      atRules: rule.atRules,
      ...(rule.parentSelectors === undefined
        ? {}
        : { parentSelectors: rule.parentSelectors }),
      selector: rule.selector,
      property: declaration.property,
      value: declaration.value,
      important: declaration.important,
      line: rule.line,
    };
  });
}

function isCreateStyleElement(node) {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length > 0 &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === "style" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "createElement"
  );
}

function isStyleJsxElement(node) {
  return (
    (ts.isJsxElement(node) &&
      node.openingElement.tagName.getText() === "style") ||
    (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "style")
  );
}

function isHtmlStyleMarkup(node, sourceFile) {
  return (
    ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.toLowerCase().includes("<style")) ||
    (ts.isTemplateExpression(node) &&
      node.getText(sourceFile).toLowerCase().includes("<style"))
  );
}

function isProductionSource(file) {
  return (
    !/(^|\/)(__tests__|test|tests|mocks|test-fixtures)(\/|$)/.test(file) &&
    !/\.(test|spec)\.tsx?$/.test(file)
  );
}

function styleInjectionRecord(file, sourceFile, kind, node) {
  const code = normalizedCode(node.getText(sourceFile));
  return {
    file,
    kind,
    fingerprint: hash(code),
    preview: code.slice(0, 120),
    line:
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1,
  };
}

function collectStyleInjections(file, text) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const styleElementNames = new Set();
  const styleSheetNames = new Set();
  const records = [];

  function collectNames(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      if (isCreateStyleElement(node.initializer)) {
        styleElementNames.add(node.name.text);
      }
      if (
        ts.isNewExpression(node.initializer) &&
        node.initializer.expression.getText(sourceFile) === "CSSStyleSheet"
      ) {
        styleSheetNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectNames);
  }
  collectNames(sourceFile);

  function visit(node) {
    if (isStyleJsxElement(node)) {
      records.push(styleInjectionRecord(file, sourceFile, "jsx-style", node));
    } else if (isCreateStyleElement(node)) {
      records.push(
        styleInjectionRecord(file, sourceFile, "create-style-element", node),
      );
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      styleElementNames.has(node.left.expression.text) &&
      (node.left.name.text === "textContent" ||
        node.left.name.text === "innerHTML")
    ) {
      records.push(
        styleInjectionRecord(file, sourceFile, "style-content-write", node),
      );
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(sourceFile) === "CSSStyleSheet"
    ) {
      records.push(
        styleInjectionRecord(file, sourceFile, "css-style-sheet", node),
      );
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      styleSheetNames.has(node.expression.expression.text) &&
      ["insertRule", "replace", "replaceSync"].includes(
        node.expression.name.text,
      )
    ) {
      records.push(
        styleInjectionRecord(file, sourceFile, "style-sheet-write", node),
      );
    } else if (
      ts.isTaggedTemplateExpression(node) &&
      (node.tag.getText(sourceFile) === "css" ||
        node.tag.getText(sourceFile).startsWith("styled.") ||
        node.tag.getText(sourceFile).startsWith("styled("))
    ) {
      records.push(styleInjectionRecord(file, sourceFile, "css-in-js", node));
    } else if (isHtmlStyleMarkup(node, sourceFile)) {
      records.push(
        styleInjectionRecord(file, sourceFile, "html-style-markup", node),
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return records;
}

// Anything the allowlist did not claim is a violation. There is no grandfathered
// set to compare against: the migration that needed one is finished.
function reportRecords(file, records, key, label, issues) {
  const reported = new Set();
  for (const record of records) {
    const recordKey = key(record);
    if (reported.has(recordKey)) {
      continue;
    }
    reported.add(recordKey);
    issues.push({
      type: "growth",
      file,
      line: record.line ?? 1,
      message: `New ${label} is forbidden. Use Tailwind utilities in the component; business code must not expand the style allowlist.`,
    });
  }
}

function stableRecord(record) {
  const { line: _line, ...stable } = record;
  return stable;
}

function collectCurrentStyleState({ root = PROJECT_ROOT, allowlist }) {
  const issues = [];
  const allowlistedSelectors = new Set(allowlist.selectors.map(selectorKey));
  const seenSelectors = new Set();
  const vendorFiles = new Map(
    allowlist.vendorFiles.map((entry) => [entry.file, entry]),
  );
  const cssAtoms = {};

  const cssFiles = globSync(CSS_GLOBS, { cwd: root }).sort();
  for (const file of cssFiles) {
    const text = readFileSync(resolve(root, file), "utf8");
    const vendor = vendorFiles.get(file);
    if (vendor !== undefined) {
      if (hash(text) !== vendor.sha256) {
        issues.push({
          type: "vendor",
          file,
          line: 1,
          message:
            "Vendored CSS changed. Update the pinned upstream artifact and its exact SHA-256 allowlist entry together.",
        });
      }
      continue;
    }

    const atoms = [];
    for (const rule of collectCssClassRules(file, text)) {
      const key = selectorKey(rule);
      if (allowlistedSelectors.has(key)) {
        seenSelectors.add(key);
        continue;
      }
      atoms.push(...cssAtomsForRule(rule));
    }
    if (atoms.length > 0) {
      cssAtoms[file] = atoms.map(stableRecord);
    }
  }

  for (const entry of allowlist.selectors) {
    if (!seenSelectors.has(selectorKey(entry))) {
      issues.push({
        type: "allowlist",
        file: entry.file,
        line: 1,
        message: `Selector allowlist entry is stale: ${entry.selector}`,
      });
    }
  }

  for (const entry of allowlist.vendorFiles) {
    if (!cssFiles.includes(entry.file)) {
      issues.push({
        type: "allowlist",
        file: entry.file,
        line: 1,
        message: "Vendored CSS allowlist entry points to a missing file.",
      });
    }
  }

  const styleInjections = {};
  const allowlistedInjections = new Set(
    allowlist.styleInjections.map(injectionKey),
  );
  const seenInjections = new Set();
  const sourceFiles = globSync(SOURCE_GLOBS, { cwd: root })
    .filter(isProductionSource)
    .sort();
  const classUsages = collectClassUsages(
    root,
    sourceFiles,
    allowlist.classDependencies.map((entry) => {
      return entry.token;
    }),
  );

  for (const file of sourceFiles) {
    const text = readFileSync(resolve(root, file), "utf8");
    const injections = [];
    for (const injection of collectStyleInjections(file, text)) {
      const key = injectionKey(injection);
      if (allowlistedInjections.has(key)) {
        seenInjections.add(key);
        continue;
      }
      injections.push(stableRecord(injection));
    }
    if (injections.length > 0) {
      styleInjections[file] = injections;
    }
  }

  for (const entry of allowlist.styleInjections) {
    if (!seenInjections.has(injectionKey(entry))) {
      issues.push({
        type: "allowlist",
        file: entry.file,
        line: 1,
        message: `Style injection allowlist entry is stale: ${entry.preview}`,
      });
    }
  }

  return { cssAtoms, classUsages, styleInjections, issues };
}

export function checkStylePolicy({
  root = PROJECT_ROOT,
  allowlist = readJson(ALLOWLIST_PATH),
} = {}) {
  const issues = validatePolicyFiles(allowlist).map((message) => {
    return {
      type: "policy",
      file: "style-allowlist.json",
      line: 1,
      message,
    };
  });
  const current = collectCurrentStyleState({ root, allowlist });
  issues.push(...current.issues);

  const cssFiles = new Set(Object.keys(current.cssAtoms));
  for (const file of cssFiles) {
    reportRecords(
      file,
      current.cssAtoms[file] ?? [],
      cssAtomKey,
      "first-party CSS class selector declaration",
      issues,
    );
  }

  // An allowlisted class dependency pins an exact count in an exact file. It is
  // the only expectation there is: every other use of the token is a violation.
  const allowlistedUsage = {};
  for (const entry of allowlist.classDependencies) {
    allowlistedUsage[entry.file] ??= {};
    allowlistedUsage[entry.file][entry.token] = entry.count;
  }

  const sourceFiles = new Set([
    ...Object.keys(current.classUsages),
    ...Object.keys(allowlistedUsage),
  ]);
  for (const file of sourceFiles) {
    const currentUsage = current.classUsages[file] ?? {};
    const allowedUsage = allowlistedUsage[file] ?? {};
    for (const token of new Set([
      ...Object.keys(currentUsage),
      ...Object.keys(allowedUsage),
    ])) {
      const allowed = allowedUsage[token];
      const actual = currentUsage[token] ?? 0;
      const expected = allowed ?? 0;
      if (actual > expected) {
        issues.push({
          type: "growth",
          file,
          line: 1,
          message:
            allowed === undefined
              ? `Class \`${token}\` is allowlisted for another file, not this one. Use Tailwind utilities here.`
              : `Allowlisted class \`${token}\` usage grew from ${expected} to ${actual}. An allowlist entry authorizes an exact count; it is not a license to spread the class.`,
        });
      } else if (actual < expected) {
        // Reaching here means `allowed` is defined: an absent entry expects 0,
        // and a count cannot fall below it.
        issues.push({
          type: "stale",
          file,
          line: 1,
          message: `Allowlisted class \`${token}\` usage fell from ${expected} to ${actual}. Lower the count in style-allowlist.json, or remove the entry.`,
        });
      }
    }
  }

  for (const file of Object.keys(current.styleInjections)) {
    reportRecords(
      file,
      current.styleInjections[file] ?? [],
      (record) => {
        return JSON.stringify([record.kind, record.fingerprint]);
      },
      "inline or injected stylesheet",
      issues,
    );
  }

  return { current, issues };
}

function printIssues(issues) {
  for (const issue of issues) {
    console.error(
      `${issue.file}:${issue.line}:1 error ${issue.message} Read docs/styles.md for the style guide. [style-policy/${issue.type}]`,
    );
  }
}

function run() {
  const result = checkStylePolicy();
  if (result.issues.length > 0) {
    printIssues(result.issues);
    process.exitCode = 1;
    return;
  }
  console.log("Style policy passed.");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    run();
  } catch (error) {
    printIssues([
      {
        type: "configuration",
        file: "style-allowlist.json",
        line: 1,
        message: error.message,
      },
    ]);
    process.exitCode = 1;
  }
}
