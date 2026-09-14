#!/usr/bin/env node

import fs from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  testProjectNames,
  validateTestProjects,
} from "./prepare-typecheck-tests.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "src");
const baselineConfig = "tsconfig.json";
const programConfigs = [
  "tsconfig.gateways.json",
  "tsconfig.core.json",
  "tsconfig.routes.json",
  "tsconfig.bootstrap.json",
  ...testProjectNames,
  "tsconfig.bootstrap-wiring.json",
];

function fail(message, details = []) {
  process.stderr.write(`${message}\n`);
  for (const detail of details) {
    process.stderr.write(`  ${detail}\n`);
  }
  process.exitCode = 1;
}

function readConfig(configName) {
  const configPath = resolve(packageRoot, configName);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => {
          return ts.flattenDiagnosticMessageText(error.messageText, "\n");
        })
        .join("\n"),
    );
  }
  return parsed;
}

function typeScriptRoots(configName) {
  return new Set(
    readConfig(configName)
      .fileNames.filter((fileName) => {
        const extension = extname(fileName);
        return extension === ".ts" || extension === ".tsx";
      })
      .map((fileName) => {
        return resolve(fileName);
      }),
  );
}

function display(fileName) {
  return relative(packageRoot, fileName).replaceAll("\\", "/");
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const target = resolve(dirname(importer), specifier);
  for (const candidate of [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    resolve(target, "index.ts"),
    resolve(target, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return resolve(candidate);
    }
  }
  return undefined;
}

function importBindings(sourceFile) {
  const bindings = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    bindings.push({
      statement,
      specifier: statement.moduleSpecifier.text,
      named:
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
          ? statement.importClause.namedBindings.elements
          : [],
    });
  }
  return bindings;
}

function moduleReferences(sourceFile) {
  const references = [];
  function visit(node) {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifier = node.argument.literal.text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier) {
      references.push({ node, specifier });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return references;
}

validateTestProjects(packageRoot);

const baselineRoots = typeScriptRoots(baselineConfig);
const ownersByRoot = new Map();
const counts = new Map();
for (const configName of programConfigs) {
  const roots = typeScriptRoots(configName);
  counts.set(configName, roots.size);
  for (const root of roots) {
    const owners = ownersByRoot.get(root) ?? [];
    owners.push(configName);
    ownersByRoot.set(root, owners);
  }
}

const missingRoots = [...baselineRoots].filter((root) => {
  return !ownersByRoot.has(root);
});
const extraRoots = [...ownersByRoot.keys()].filter((root) => {
  return !baselineRoots.has(root);
});
const overlappingRoots = [...ownersByRoot].filter(([, owners]) => {
  return owners.length > 1;
});
if (missingRoots.length > 0) {
  fail(
    "TypeScript Program boundary is missing baseline roots:",
    missingRoots.map(display),
  );
}
if (extraRoots.length > 0) {
  fail(
    "TypeScript Program boundary contains roots outside the baseline:",
    extraRoots.map(display),
  );
}
if (overlappingRoots.length > 0) {
  fail(
    "TypeScript roots must belong to exactly one Program:",
    overlappingRoots.map(([root, owners]) => {
      return `${display(root)} (${owners.join(", ")})`;
    }),
  );
}

// JSON requires explicit composite roots; the broad TypeScript include does
// not select it. Test/bench/fixture patterns stay owned by the canonical tests.
const productionJsonRoots = new Set(
  ts.sys
    .readDirectory(
      packageRoot,
      [".json"],
      readConfig("tsconfig.tests.json").raw.include,
      ["src/**/*.json"],
    )
    .map((file) => {
      return resolve(file);
    }),
);
const jsonOwners = new Map();
for (const name of ["tsconfig.core.json", "tsconfig.routes.json"]) {
  for (const file of readConfig(name).fileNames.filter((file) => {
    return extname(file) === ".json";
  })) {
    const owners = jsonOwners.get(file) ?? [];
    owners.push(name);
    jsonOwners.set(file, owners);
  }
}
const missingJson = [...productionJsonRoots].filter((file) => {
  return !jsonOwners.has(file);
});
const extraJson = [...jsonOwners.keys()].filter((file) => {
  return !productionJsonRoots.has(file);
});
const overlappingJson = [...jsonOwners].filter(([, owners]) => {
  return owners.length > 1;
});
if (missingJson.length || extraJson.length || overlappingJson.length) {
  fail("Production JSON boundary: missing, extra or overlapping inputs", [
    ...missingJson.map((file) => {
      return `missing: ${display(file)}`;
    }),
    ...extraJson.map((file) => {
      return `extra: ${display(file)}`;
    }),
    ...overlappingJson.map(([file, owners]) => {
      return `overlap: ${display(file)} (${owners.join(", ")})`;
    }),
  ]);
}

const importers = new Map();
let setupAppCalls = 0;
let createAppCalls = 0;
const implicitRouteCalls = [];
const lowerLayerRouteImports = [];
const nativePiRuntimeImports = [];

for (const root of baselineRoots) {
  const source = fs.readFileSync(root, "utf8");
  const sourceFile = ts.createSourceFile(
    root,
    source,
    ts.ScriptTarget.Latest,
    true,
    root.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const setupBindings = new Set();
  const createBindings = new Set();
  const isTestRoot =
    root.includes("/__tests__/") ||
    root.includes("/__benches__/") ||
    /\.(?:bench|spec|suite|test)\.tsx?$/u.test(root);
  const isLowerLayer =
    !isTestRoot &&
    (root.startsWith(resolve(sourceRoot, "lib") + "/") ||
      ["commands", "computed", "external", "services"].some((directory) => {
        return root.startsWith(
          resolve(sourceRoot, `signals/${directory}`) + "/",
        );
      }));

  for (const reference of moduleReferences(sourceFile)) {
    if (
      !isTestRoot &&
      (reference.specifier === "@okouai/pi-agent-runtime/node" ||
        reference.specifier.startsWith("@earendil-works/"))
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(
          reference.node.getStart(sourceFile),
        ).line + 1;
      nativePiRuntimeImports.push(`${display(root)}:${line}`);
    }
  }

  for (const imported of importBindings(sourceFile)) {
    const target = resolveRelativeImport(root, imported.specifier);
    if (target) {
      const targetImporters = importers.get(target) ?? new Set();
      targetImporters.add(root);
      importers.set(target, targetImporters);
      if (
        isLowerLayer &&
        (target.startsWith(resolve(sourceRoot, "signals/routes") + "/") ||
          target === resolve(sourceRoot, "signals/route.ts") ||
          target === resolve(sourceRoot, "signals/e2e-routes.ts"))
      ) {
        lowerLayerRouteImports.push(`${display(root)} -> ${display(target)}`);
      }
    }
    for (const element of imported.named) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (
        imported.specifier.endsWith("test-helpers") &&
        importedName === "setupApp"
      ) {
        setupBindings.add(element.name.text);
      }
      if (
        imported.specifier.endsWith("app-factory") &&
        importedName === "createApp"
      ) {
        createBindings.add(element.name.text);
      }
    }
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (setupBindings.has(node.expression.text) ||
        createBindings.has(node.expression.text))
    ) {
      const isSetup = setupBindings.has(node.expression.text);
      if (isSetup) {
        setupAppCalls += 1;
      } else {
        createAppCalls += 1;
      }
      const options = node.arguments[0];
      const hasRoutes =
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some((property) => {
          return (
            (ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property)) &&
            ((ts.isIdentifier(property.name) &&
              property.name.text === "routes") ||
              (ts.isStringLiteral(property.name) &&
                property.name.text === "routes"))
          );
        });
      if (!hasRoutes) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
        implicitRouteCalls.push(
          `${display(root)}:${line} ${node.expression.text}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

if (implicitRouteCalls.length > 0) {
  fail("Every test app must declare its route slice:", implicitRouteCalls);
}
if (lowerLayerRouteImports.length > 0) {
  fail(
    "Lower layers must not import route or bootstrap aggregation modules:",
    lowerLayerRouteImports,
  );
}
if (nativePiRuntimeImports.length > 0) {
  fail(
    "API production modules must use the declaration-isolated Pi API entrypoint:",
    nativePiRuntimeImports,
  );
}

function checkImporters(target, expectedNames) {
  const expected = new Set(
    expectedNames.map((name) => {
      return resolve(packageRoot, name);
    }),
  );
  const actual = importers.get(target) ?? new Set();
  const unexpected = [...actual].filter((fileName) => {
    return !expected.has(fileName);
  });
  const absent = [...expected].filter((fileName) => {
    return !actual.has(fileName);
  });
  if (unexpected.length > 0 || absent.length > 0) {
    fail(`Unexpected import boundary for ${display(target)}:`, [
      ...unexpected.map((fileName) => {
        return `unexpected: ${display(fileName)}`;
      }),
      ...absent.map((fileName) => {
        return `missing: ${display(fileName)}`;
      }),
    ]);
  }
}

checkImporters(resolve(sourceRoot, "signals/route.ts"), [
  "src/production-bootstrap.ts",
  "src/__tests__/route-registration.test.ts",
  "src/__tests__/vercel-crons.test.ts",
]);
checkImporters(resolve(sourceRoot, "production-bootstrap.ts"), [
  "src/index.ts",
  "src/server.ts",
]);

const dbSource = fs.readFileSync(resolve(sourceRoot, "lib/db.ts"), "utf8");
const dbSourceFile = ts.createSourceFile(
  "db.ts",
  dbSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const dbViolations = [];
for (const imported of importBindings(dbSourceFile)) {
  if (
    imported.specifier === "@okouai/db" ||
    imported.specifier.startsWith("@okouai/db/")
  ) {
    dbViolations.push(`db.ts imports ${imported.specifier}`);
  }
}
function visitDb(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "drizzle" &&
    node.arguments.length !== 1
  ) {
    dbViolations.push(`drizzle() has ${node.arguments.length} arguments`);
  }
  ts.forEachChild(node, visitDb);
}
visitDb(dbSourceFile);

const dbTypesPath = resolve(sourceRoot, "lib/db-types.ts");
const dbTypesSource = fs.readFileSync(dbTypesPath, "utf8");
const dbTypesFile = ts.createSourceFile(
  dbTypesPath,
  dbTypesSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const apiDbAlias = dbTypesFile.statements.find((statement) => {
  return (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === "ApiDb"
  );
});
if (
  !apiDbAlias ||
  !ts.isTypeAliasDeclaration(apiDbAlias) ||
  apiDbAlias.type.getText(dbTypesFile).replaceAll(/\s/gu, "") !==
    "NodePgDatabase<Record<string,never>>"
) {
  dbViolations.push(
    "ApiDb is not schema-erased NodePgDatabase<Record<string, never>>",
  );
}
if (dbViolations.length > 0) {
  fail("Drizzle relational schema fanout must remain disabled:", dbViolations);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const programSummary = programConfigs
  .map((configName) => {
    return `${configName}=${counts.get(configName)}`;
  })
  .join(", ");
process.stdout.write(
  `TypeScript boundaries: roots=${baselineRoots.size}; ${programSummary}; missing=0; extra=0; overlaps=0; production-json=${productionJsonRoots.size}; setupApp=${setupAppCalls}; createApp=${createAppCalls}; aggregate-importers=2; bootstrap-importers=2; drizzle-schema=erased\n`,
);
