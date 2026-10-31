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

import {
  assertWorkerDomainEntries,
  workerDomainRouteGroups,
  workerDomains,
} from "./worker-domain-manifest.mjs";

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

function recordModuleBindings(imports, statement) {
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

function definitions(source) {
  const vars = new Map();
  const imports = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          vars.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      vars.set(statement.name.text, statement);
    }
    recordModuleBindings(imports, statement);
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
function metadataFactoryReturn(context, body) {
  if (!ts.isBlock(body)) {
    return body;
  }
  const returns = [];
  for (const statement of body.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        assert.ok(
          ts.isIdentifier(declaration.name),
          "Factory variable must be named",
        );
        context.bindings.set(declaration.name.text, {
          node: declaration.initializer,
          context,
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
  return returns[0];
}

function metadataFactoryScope(target, node, context) {
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
  for (const [index, parameter] of fn.parameters.entries()) {
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
  }
  return { context: scoped, node: metadataFactoryReturn(scoped, fn.body) };
}

function routeMetadata(groups = aggregate) {
  const cache = new Map();
  function load(file) {
    if (!cache.has(file)) {
      cache.set(file, definitions(readSource(file)));
    }
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
      if (binding) {
        return value(binding.context, binding.node, depth + 1);
      }
      if (context.vars.has(node.text)) {
        return value(context, context.vars.get(node.text), depth + 1);
      }
      const imported = context.imports.get(node.text);
      assert.ok(imported, `Unresolved metadata identifier: ${node.text}`);
      return value(
        load(sourceModule(context.source.fileName, imported.module)),
        ts.factory.createIdentifier(imported.name),
        depth + 1,
      );
    }
    if (ts.isPropertyAccessExpression(node)) {
      return property(context, node.expression, node.name.text, depth + 1);
    }
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
      const projected = metadataFactoryScope(target, node, context);
      return value(projected.context, projected.node, depth + 1);
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
        if (found) {
          return found;
        }
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
      if (ts.isSpreadElement(element)) {
        return array(resolved.context, element.expression);
      }
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
  return groups.flatMap((group) => {
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

function methodPath(route) {
  return `${route.method} ${route.path}`;
}

test("business probes preserve selected canonical registrations and order without claiming complete coverage", (context) => {
  assertWorkerDomainEntries();
  const leaves = routeMetadata(workerDomainRouteGroups);
  const expectedCounts = {
    threads: 44,
    chat: 4,
    runs: 7,
    agents: 16,
    workflows: 23,
  };
  assert.deepEqual(Object.keys(workerDomains), Object.keys(expectedCounts));
  const selected = new Set();
  for (const [domain, definition] of Object.entries(workerDomains)) {
    assert.equal(definition.entry, `src/worker-domains/${domain}.ts`);
    const routes = leaves
      .filter((route) => {
        return definition.groups.includes(route.group);
      })
      .map(methodPath);
    assert.equal(routes.length, expectedCounts[domain]);
    const keys = new Set(routes);
    assert.equal(keys.size, routes.length);
    assert.deepEqual(
      routes,
      metadata.map(methodPath).filter((key) => {
        return keys.has(key);
      }),
      `Changed canonical route membership/order: ${domain}`,
    );
    for (const key of keys) {
      assert.ok(
        !selected.has(key),
        `Duplicate business probe registration: ${key}`,
      );
      selected.add(key);
    }
  }
  assert.equal(selected.size, 94);
  assert.ok(
    selected.size < metadata.length,
    "These probes are not a complete fleet",
  );
  context.diagnostic(
    JSON.stringify({
      partialProbes: expectedCounts,
      selected: selected.size,
      aggregate: metadata.length,
    }),
  );
});

test("MCP composes its canonical tool leaves directly in the existing tool order", () => {
  const groups = [
    "agentListRoutes",
    "runModelsRoutes",
    "chatThreadIndicatorRoutes",
    "chatThreadSnapshotRoutes",
    "chatThreadMessageReadRoutes",
    "chatThreadActivitySummaryRoutes",
    "chatInputStatusRoutes",
    "chatThreadModelSelectionRoutes",
    "chatThreadRenameRoutes",
    "chatEventsRoutes",
    "runsCancelRoutes",
  ].map((name) => {
    const group = [
      {
        name: "agentListRoutes",
        module: "./routes/agents-list",
        exportName: "agentListRoutes",
      },
      ...workerDomainRouteGroups,
      ...aggregate,
    ].find((item) => {
      return item.name === name;
    });
    assert.ok(group, `Missing MCP leaf: ${name}`);
    return group;
  });
  const expected = routeMetadata(groups).map(methodPath);
  expected.push("GET /api/chat/search");
  const actual = routeMetadata([
    {
      name: "toolRoutes",
      module: "./routes/mcp-server",
      exportName: "toolRoutes",
    },
  ]).map(methodPath);
  assert.equal(actual.length, 14);
  assert.deepEqual(actual, expected);
  const source = readSource(
    resolve(apiRoot, "src/signals/routes/mcp-server.ts"),
  );
  const imports = new Set(
    source.statements.filter(ts.isImportDeclaration).map((statement) => {
      return statement.moduleSpecifier.text;
    }),
  );
  assert.ok(!imports.has("./agents"));
  assert.ok(!imports.has("./chat-threads"));
});
