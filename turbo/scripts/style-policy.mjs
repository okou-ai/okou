import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { fork } from "@eslint/css-tree";
import { tailwind4 } from "tailwind-csstree";
import ts from "typescript";

import { collectLegacyClassUsages } from "./style-class-usage.mjs";

const STYLE_POLICY_VERSION = 1;
const PROJECT_ROOT = process.cwd();
const ALLOWLIST_PATH = resolve(PROJECT_ROOT, "style-allowlist.json");
const BASELINE_PATH = resolve(PROJECT_ROOT, "style-legacy-baseline.json");
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBaseline(baseline) {
  if (!isRecord(baseline) || baseline.version !== STYLE_POLICY_VERSION) {
    throw new Error(
      `Style baseline must be a version ${STYLE_POLICY_VERSION} object.`,
    );
  }
  if (
    !Array.isArray(baseline.legacyClassTokens) ||
    !baseline.legacyClassTokens.every(
      (token) => typeof token === "string" && token.length > 0,
    )
  ) {
    throw new Error(
      "Style baseline legacyClassTokens must contain non-empty strings.",
    );
  }
  for (const field of ["cssAtoms", "styleInjections"]) {
    if (
      !isRecord(baseline[field]) ||
      !Object.values(baseline[field]).every(
        (records) => Array.isArray(records) && records.every(isRecord),
      )
    ) {
      throw new Error(
        `Style baseline ${field} must map files to arrays of records.`,
      );
    }
  }
  if (!isRecord(baseline.classUsages)) {
    throw new Error(
      "Style baseline classUsages must map files to class counts.",
    );
  }
  for (const [file, usage] of Object.entries(baseline.classUsages)) {
    if (
      !isRecord(usage) ||
      !Object.values(usage).every(
        (count) => Number.isSafeInteger(count) && count > 0,
      )
    ) {
      throw new Error(
        `Style baseline classUsages in ${file} must contain positive integer counts.`,
      );
    }
  }
}

export function validatePolicyFiles(allowlist, baseline) {
  assertBaseline(baseline);
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

function countBy(records, key) {
  const counts = new Map();
  for (const record of records) {
    const recordKey = key(record);
    counts.set(recordKey, (counts.get(recordKey) ?? 0) + 1);
  }
  return counts;
}

function compareRecords(file, current, expected, key, label, issues) {
  const currentCounts = countBy(current, key);
  const expectedCounts = countBy(expected, key);
  const reportedGrowth = new Set();
  const reportedStale = new Set();

  for (const record of current) {
    const recordKey = key(record);
    if (
      (currentCounts.get(recordKey) ?? 0) >
        (expectedCounts.get(recordKey) ?? 0) &&
      !reportedGrowth.has(recordKey)
    ) {
      reportedGrowth.add(recordKey);
      issues.push({
        type: "growth",
        file,
        line: record.line ?? 1,
        message: `New ${label} is forbidden. Use Tailwind utilities in the component; business code must not expand the style allowlist.`,
      });
    }
  }

  for (const record of expected) {
    const recordKey = key(record);
    if (
      (expectedCounts.get(recordKey) ?? 0) >
        (currentCounts.get(recordKey) ?? 0) &&
      !reportedStale.has(recordKey)
    ) {
      reportedStale.add(recordKey);
      issues.push({
        type: "stale",
        file,
        line: 1,
        message: `Legacy ${label} was removed or changed. Run \`pnpm lint:style:prune\` to ratchet the baseline down.`,
      });
    }
  }
}

function stableRecord(record) {
  const { line: _line, ...stable } = record;
  return stable;
}

function collectCurrentStyleState({
  root = PROJECT_ROOT,
  allowlist,
  baseline,
}) {
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
  const classUsages = collectLegacyClassUsages(root, sourceFiles, [
    ...new Set([
      ...baseline.legacyClassTokens,
      ...allowlist.classDependencies.map((entry) => {
        return entry.token;
      }),
    ]),
  ]);

  for (const file of sourceFiles) {
    const text = readFileSync(resolve(root, file), "utf8");
    const legacyInjections = [];
    for (const injection of collectStyleInjections(file, text)) {
      const key = injectionKey(injection);
      if (allowlistedInjections.has(key)) {
        seenInjections.add(key);
        continue;
      }
      legacyInjections.push(stableRecord(injection));
    }
    if (legacyInjections.length > 0) {
      styleInjections[file] = legacyInjections;
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
  baseline = readJson(BASELINE_PATH),
} = {}) {
  const issues = validatePolicyFiles(allowlist, baseline).map((message) => {
    return {
      type: "policy",
      file: "style-allowlist.json",
      line: 1,
      message,
    };
  });
  const current = collectCurrentStyleState({ root, allowlist, baseline });
  issues.push(...current.issues);

  const cssFiles = new Set([
    ...Object.keys(current.cssAtoms),
    ...Object.keys(baseline.cssAtoms),
  ]);
  for (const file of cssFiles) {
    compareRecords(
      file,
      current.cssAtoms[file] ?? [],
      baseline.cssAtoms[file] ?? [],
      cssAtomKey,
      "first-party CSS class selector declaration",
      issues,
    );
  }

  // An allowlisted class dependency pins an exact count in an exact file, the
  // way a baseline entry does. It is not prunable, so a count that no longer
  // matches points at the allowlist rather than at the ratchet.
  const allowlistedUsage = {};
  for (const entry of allowlist.classDependencies) {
    allowlistedUsage[entry.file] ??= {};
    allowlistedUsage[entry.file][entry.token] = entry.count;
  }

  const sourceFiles = new Set([
    ...Object.keys(current.classUsages),
    ...Object.keys(baseline.classUsages),
    ...Object.keys(allowlistedUsage),
  ]);
  for (const file of sourceFiles) {
    const currentUsage = current.classUsages[file] ?? {};
    const baselineUsage = baseline.classUsages[file] ?? {};
    const allowedUsage = allowlistedUsage[file] ?? {};
    for (const token of new Set([
      ...Object.keys(currentUsage),
      ...Object.keys(baselineUsage),
      ...Object.keys(allowedUsage),
    ])) {
      const allowed = allowedUsage[token];
      const actual = currentUsage[token] ?? 0;
      const expected = allowed ?? baselineUsage[token] ?? 0;
      if (actual > expected) {
        issues.push({
          type: "growth",
          file,
          line: 1,
          message:
            allowed === undefined
              ? `Legacy class \`${token}\` usage grew from ${expected} to ${actual}. Replace the new use with Tailwind utilities.`
              : `Allowlisted class \`${token}\` usage grew from ${expected} to ${actual}. An allowlist entry authorizes an exact count; it is not a license to spread the class.`,
        });
      } else if (actual < expected) {
        issues.push({
          type: "stale",
          file,
          line: 1,
          message:
            allowed === undefined
              ? `Legacy class \`${token}\` usage fell from ${expected} to ${actual}. Run \`pnpm lint:style:prune\` to ratchet the baseline down.`
              : `Allowlisted class \`${token}\` usage fell from ${expected} to ${actual}. Lower the count in style-allowlist.json, or remove the entry.`,
        });
      }
    }
  }

  const injectionFiles = new Set([
    ...Object.keys(current.styleInjections),
    ...Object.keys(baseline.styleInjections),
  ]);
  for (const file of injectionFiles) {
    compareRecords(
      file,
      current.styleInjections[file] ?? [],
      baseline.styleInjections[file] ?? [],
      (record) => JSON.stringify([record.kind, record.fingerprint]),
      "inline or injected stylesheet",
      issues,
    );
  }

  return { current, issues };
}

function intersection(expected, current, key) {
  const available = countBy(current, key);
  return expected.filter((record) => {
    const recordKey = key(record);
    const count = available.get(recordKey) ?? 0;
    if (count === 0) {
      return false;
    }
    available.set(recordKey, count - 1);
    return true;
  });
}

function prunedBaseline(baseline, current) {
  const cssAtoms = {};
  for (const [file, atoms] of Object.entries(baseline.cssAtoms)) {
    const retained = intersection(
      atoms,
      current.cssAtoms[file] ?? [],
      cssAtomKey,
    );
    if (retained.length > 0) {
      cssAtoms[file] = retained;
    }
  }

  const classUsages = {};
  const usedTokens = new Set();
  for (const [file, expected] of Object.entries(baseline.classUsages)) {
    const actual = current.classUsages[file] ?? {};
    const retained = {};
    for (const [token, count] of Object.entries(expected)) {
      const nextCount = Math.min(count, actual[token] ?? 0);
      if (nextCount > 0) {
        retained[token] = nextCount;
        usedTokens.add(token);
      }
    }
    if (Object.keys(retained).length > 0) {
      classUsages[file] = retained;
    }
  }

  const styleInjections = {};
  for (const [file, injections] of Object.entries(baseline.styleInjections)) {
    const retained = intersection(
      injections,
      current.styleInjections[file] ?? [],
      (record) => JSON.stringify([record.kind, record.fingerprint]),
    );
    if (retained.length > 0) {
      styleInjections[file] = retained;
    }
  }

  return {
    version: STYLE_POLICY_VERSION,
    legacyClassTokens: baseline.legacyClassTokens.filter((token) => {
      return usedTokens.has(token);
    }),
    cssAtoms,
    classUsages,
    styleInjections,
  };
}

function reportBaselineRecordGrowth(
  currentByFile,
  referenceByFile,
  key,
  label,
  errors,
) {
  for (const [file, records] of Object.entries(currentByFile)) {
    const currentCounts = countBy(records, key);
    const referenceCounts = countBy(referenceByFile[file] ?? [], key);
    for (const [recordKey, count] of currentCounts) {
      if (count > (referenceCounts.get(recordKey) ?? 0)) {
        errors.push(
          `Shrink-only baseline added ${label} in ${file}; remove the addition and use Tailwind utilities.`,
        );
      }
    }
  }
}

function baselineGrowthErrors(baseline, reference) {
  const errors = [];
  const referenceTokens = new Set(reference.legacyClassTokens);
  for (const token of baseline.legacyClassTokens) {
    if (!referenceTokens.has(token)) {
      errors.push(
        `Shrink-only baseline added legacy class token \`${token}\`; remove the addition and use Tailwind utilities.`,
      );
    }
  }

  reportBaselineRecordGrowth(
    baseline.cssAtoms,
    reference.cssAtoms,
    cssAtomKey,
    "a CSS selector declaration",
    errors,
  );
  reportBaselineRecordGrowth(
    baseline.styleInjections,
    reference.styleInjections,
    (record) => JSON.stringify([record.kind, record.fingerprint]),
    "an inline or injected stylesheet",
    errors,
  );

  for (const [file, usage] of Object.entries(baseline.classUsages)) {
    const referenceUsage = reference.classUsages[file] ?? {};
    for (const [token, count] of Object.entries(usage)) {
      if (count > (referenceUsage[token] ?? 0)) {
        errors.push(
          `Shrink-only baseline grew legacy class \`${token}\` from ${referenceUsage[token] ?? 0} to ${count} in ${file}; remove the addition and use Tailwind utilities.`,
        );
      }
    }
  }
  return errors;
}

function baselineAtGitRef(ref) {
  const commit = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const baselineFile = "turbo/style-legacy-baseline.json";
  const entry = execFileSync(
    "git",
    ["ls-tree", "--full-tree", "--name-only", "-z", commit, "--", baselineFile],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );
  // The initial lint PR has no baseline on its base commit. Only that actual
  // absence skips the ratchet; Git failures and malformed existing data fail.
  // This is repository-history bootstrap, not deployed-version compatibility.
  // Remove when all supported ratchet refs contain the baseline; tracked by #32402.
  if (entry === "") {
    return undefined;
  }
  const baseline = JSON.parse(
    execFileSync("git", ["show", `${commit}:${baselineFile}`], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    }),
  );
  assertBaseline(baseline);
  return baseline;
}

function printIssues(issues) {
  for (const issue of issues) {
    console.error(
      `${issue.file}:${issue.line}:1 error ${issue.message} Read docs/styles.md for the style guide. [style-policy/${issue.type}]`,
    );
  }
}

function run() {
  const prune = process.argv.slice(2).includes("--prune");
  const baseline = readJson(BASELINE_PATH);
  assertBaseline(baseline);
  const ratchetRef = process.env.STYLE_POLICY_RATCHET_REF ?? "HEAD";
  const referenceBaseline = baselineAtGitRef(ratchetRef);
  const baselineErrors =
    referenceBaseline === undefined
      ? []
      : baselineGrowthErrors(baseline, referenceBaseline);
  if (baselineErrors.length > 0) {
    printIssues(
      baselineErrors.map((message) => ({
        type: "baseline-growth",
        file: "style-legacy-baseline.json",
        line: 1,
        message,
      })),
    );
    process.exitCode = 1;
    return;
  }

  const result = checkStylePolicy();
  const blocking = result.issues.filter((issue) => {
    return issue.type !== "stale";
  });

  if (prune) {
    if (blocking.length > 0) {
      printIssues(blocking);
      process.exitCode = 1;
      return;
    }
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(prunedBaseline(baseline, result.current), null, 2)}\n`,
    );
    console.log("Pruned style-legacy-baseline.json; no allowance was added.");
    return;
  }

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
        file: "style-legacy-baseline.json",
        line: 1,
        message: error.message,
      },
    ]);
    process.exitCode = 1;
  }
}
