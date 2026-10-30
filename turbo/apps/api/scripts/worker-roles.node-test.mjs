import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

import {
  assertWorkerRoleEntries,
  assertWorkerRoleOwnership,
  readAggregateRouteGroups,
  workerRoles,
} from "./worker-role-manifest.mjs";

const apiRoot = resolve(import.meta.dirname, "..");
const contractsRoot = resolve(apiRoot, "../../packages/api-contracts/src");
const aggregate = readAggregateRouteGroups();

function readSource(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(source.parseDiagnostics.length, 0, `Cannot parse ${file}`);
  return source;
}

function definitions(source) {
  const vars = new Map();
  const imports = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          vars.set(declaration.name.text, declaration.initializer);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name)
      vars.set(statement.name.text, statement);
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const binding of statement.importClause.namedBindings.elements) {
        imports.set(binding.name.text, {
          module: statement.moduleSpecifier.text,
          name: binding.propertyName?.text ?? binding.name.text,
        });
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const binding of statement.exportClause.elements) {
        imports.set(binding.name.text, {
          module: statement.moduleSpecifier.text,
          name: binding.propertyName?.text ?? binding.name.text,
        });
      }
    }
  }
  return { source, vars, imports, bindings: new Map() };
}

function sourceModule(file, specifier) {
  const base = specifier.startsWith(".")
    ? resolve(dirname(file), specifier)
    : specifier.startsWith("@okouai/api-contracts/")
      ? resolve(contractsRoot, specifier.slice("@okouai/api-contracts/".length))
      : undefined;
  assert.ok(base, `Unexpected route metadata import: ${specifier}`);
  const candidate = [base, `${base}.ts`, resolve(base, "index.ts")].find(
    (path) => {
      return existsSync(path) && statSync(path).isFile();
    },
  );
  assert.ok(candidate, `Cannot resolve ${specifier} from ${file}`);
  return candidate;
}

// Static data projection only: read array entries and their route.method/path.
// Never import API/contract modules, inspect handlers, or execute source functions.
// Simple source-local factories (including the identity contract router) are
// projected from their AST return value with lexical argument bindings.
function routeMetadata() {
  const cache = new Map();
  function load(file) {
    if (!cache.has(file)) cache.set(file, definitions(readSource(file)));
    return cache.get(file);
  }
  function value(context, node, depth = 0) {
    assert.ok(
      node,
      `Missing static route metadata in ${context.source.fileName}`,
    );
    assert.ok(depth < 100, "Cyclic or unsupported route metadata");
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return value(context, node.expression, depth + 1);
    }
    if (ts.isIdentifier(node)) {
      const binding = context.bindings.get(node.text);
      if (binding) return value(binding.context, binding.node, depth + 1);
      if (context.vars.has(node.text))
        return value(context, context.vars.get(node.text), depth + 1);
      const imported = context.imports.get(node.text);
      assert.ok(imported, `Unresolved metadata identifier: ${node.text}`);
      return value(
        load(sourceModule(context.source.fileName, imported.module)),
        ts.factory.createIdentifier(imported.name),
        depth + 1,
      );
    }
    if (ts.isPropertyAccessExpression(node))
      return property(context, node.expression, node.name.text, depth + 1);
    if (ts.isElementAccessExpression(node)) {
      const key = value(context, node.argumentExpression, depth + 1).node;
      assert.ok(
        ts.isStringLiteral(key),
        "Only static metadata keys are supported",
      );
      return property(context, node.expression, key.text, depth + 1);
    }
    if (ts.isCallExpression(node)) {
      const target = value(context, node.expression, depth + 1);
      const fn = target.node;
      assert.ok(
        ts.isFunctionDeclaration(fn) ||
          ts.isFunctionExpression(fn) ||
          ts.isArrowFunction(fn),
        "Only explicit source-local metadata factories are supported",
      );
      assert.ok(fn.body, "Metadata factory requires a body");
      const scoped = {
        ...target.context,
        bindings: new Map(target.context.bindings),
      };
      fn.parameters.forEach((parameter, index) => {
        assert.ok(
          ts.isIdentifier(parameter.name),
          "Metadata factory parameter must be named",
        );
        const argument = node.arguments[index];
        assert.ok(
          argument || parameter.initializer,
          "Missing metadata factory argument",
        );
        scoped.bindings.set(
          parameter.name.text,
          argument
            ? { node: argument, context }
            : { node: parameter.initializer, context: scoped },
        );
      });
      if (!ts.isBlock(fn.body)) return value(scoped, fn.body, depth + 1);
      const returns = [];
      for (const statement of fn.body.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            assert.ok(
              ts.isIdentifier(declaration.name),
              "Factory variable must be named",
            );
            scoped.bindings.set(declaration.name.text, {
              node: declaration.initializer,
              context: scoped,
            });
          }
        } else {
          assert.ok(
            ts.isReturnStatement(statement),
            "Unsupported metadata factory control flow",
          );
          returns.push(statement.expression);
        }
      }
      assert.equal(
        returns.length,
        1,
        "Metadata factory must have one unconditional return",
      );
      return value(scoped, returns[0], depth + 1);
    }
    return { context, node };
  }
  function findProperty(context, node, key, depth) {
    const object = value(context, node, depth + 1);
    assert.ok(
      ts.isObjectLiteralExpression(object.node),
      `Expected metadata object for ${key}`,
    );
    for (const item of [...object.node.properties].reverse()) {
      if (ts.isSpreadAssignment(item)) {
        const found = findProperty(
          object.context,
          item.expression,
          key,
          depth + 1,
        );
        if (found) return found;
      } else if (
        item.name &&
        (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
        item.name.text === key
      ) {
        assert.ok(
          ts.isPropertyAssignment(item),
          "Metadata properties must be explicit assignments",
        );
        return value(object.context, item.initializer, depth + 1);
      }
    }
    return undefined;
  }
  function property(context, node, key, depth) {
    const found = findProperty(context, node, key, depth);
    assert.ok(found, `Missing route metadata property: ${key}`);
    return found;
  }
  function array(context, node) {
    const resolved = value(context, node);
    assert.ok(
      ts.isArrayLiteralExpression(resolved.node),
      "Route group must resolve to a static array",
    );
    return resolved.node.elements.flatMap((element) => {
      if (ts.isSpreadElement(element))
        return array(resolved.context, element.expression);
      const route = property(resolved.context, element, "route", 0);
      const method = property(route.context, route.node, "method", 0).node;
      const path = property(route.context, route.node, "path", 0).node;
      assert.ok(
        ts.isStringLiteral(method) && ts.isStringLiteral(path),
        "Route method/path must be literal strings",
      );
      return [{ method: method.text, path: path.text }];
    });
  }
  return aggregate.flatMap((group) => {
    const context = load(
      sourceModule(resolve(apiRoot, "src/signals/route.ts"), group.module),
    );
    return array(context, ts.factory.createIdentifier(group.exportName)).map(
      (route) => {
        return { ...route, group: group.name };
      },
    );
  });
}

const metadata = routeMetadata();

test("every current aggregate group has exactly one explicit owner in aggregate order", () => {
  assert.deepEqual(
    Object.keys(workerRoles).sort(),
    [
      "runtime",
      "realtime",
      "control",
      "settlement",
      "objects",
      "capabilities",
      "delivery",
      "source-events",
      "mcp",
    ].sort(),
  );
  assertWorkerRoleOwnership();
});

test("ownership guard rejects missing, duplicate, stale and reordered groups", () => {
  const missing = globalThis.structuredClone(workerRoles);
  missing.runtime.groups.shift();
  assert.throws(() => {
    return assertWorkerRoleOwnership(missing);
  }, /Missing explicit route group ownership/);
  const duplicate = globalThis.structuredClone(workerRoles);
  duplicate.realtime.groups.push(duplicate.runtime.groups[0]);
  assert.throws(() => {
    return assertWorkerRoleOwnership(duplicate);
  }, /Duplicate route group ownership/);
  const stale = globalThis.structuredClone(workerRoles);
  stale.control.groups.push("unclassifiedRoutes");
  assert.throws(() => {
    return assertWorkerRoleOwnership(stale);
  }, /Stale or unknown route group/);
  const reordered = globalThis.structuredClone(workerRoles);
  reordered.objects.groups.reverse();
  assert.throws(() => {
    return assertWorkerRoleOwnership(reordered);
  }, /Route order differs/);
  assert.throws(() => {
    return assertWorkerRoleOwnership(workerRoles, [
      ...aggregate,
      {
        name: "newCurrentRoutes",
        module: "./routes/new-current",
        exportName: "newCurrentRoutes",
      },
    ]);
  }, /Missing explicit route group ownership/);
});

test("all role roots statically compose only their own original arrays and required initializer", () => {
  assertWorkerRoleEntries();
});

test("current registered method/path pairs are unique and same-path methods have one native owner", (context) => {
  const owners = new Map(
    Object.entries(workerRoles).flatMap(([role, config]) => {
      return config.groups.map((group) => {
        return [group, role];
      });
    }),
  );
  const methodPaths = new Set();
  const pathOwners = new Map();
  for (const route of metadata) {
    const key = `${route.method} ${route.path}`;
    assert.ok(!methodPaths.has(key), `Duplicate route registration: ${key}`);
    methodPaths.add(key);
    const owner = owners.get(route.group);
    assert.ok(owner, `Unclassified route group: ${route.group}`);
    assert.ok(
      !pathOwners.has(route.path) || pathOwners.get(route.path) === owner,
      `Native path ownership is method-independent: ${route.path}`,
    );
    pathOwners.set(route.path, owner);
  }
  context.diagnostic(
    JSON.stringify({
      groups: aggregate.length,
      routes: metadata.length,
      paths: pathOwners.size,
      roles: Object.fromEntries(
        Object.entries(workerRoles).map(([role, config]) => {
          return [
            role,
            {
              groups: config.groups.length,
              routes: metadata.filter((route) => {
                return config.groups.includes(route.group);
              }).length,
              initializeChatRunFinishedEvents:
                config.initializeChatRunFinishedEvents,
            },
          ];
        }),
      ),
    }),
  );
});
