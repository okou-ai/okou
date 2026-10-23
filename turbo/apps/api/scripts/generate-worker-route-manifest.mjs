import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import {
  ROUTE_MODULE_OWNERSHIP,
  WORKER_DOMAINS,
} from "./worker-domain-ownership.mjs";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routeRoot = resolve(apiRoot, "src/signals/routes");
const domainsRoot = resolve(apiRoot, "src/worker-domains");

function fail(context, node, message) {
  throw new Error(`${context.path}: ${message}: ${node.getText(context.file)}`);
}

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

class RouteMetadataExtractor {
  modules = new Map();
  contractImports = new Map();
  async loadModule(path) {
    let context = this.modules.get(path);
    if (context) {
      return context;
    }
    const source = await readFile(path, "utf8");
    const file = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    if (file.parseDiagnostics.length > 0) {
      const diagnostic = file.parseDiagnostics[0];
      throw new Error(
        `${path}: Invalid route source: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      );
    }
    context = {
      path,
      file,
      imports: new Map(),
      variables: new Map(),
      functions: new Map(),
    };
    this.modules.set(path, context);
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (clause?.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) {
          continue;
        }
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly) {
            context.imports.set(binding.name.text, {
              module: statement.moduleSpecifier.text,
              exported: binding.propertyName?.text ?? binding.name.text,
            });
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const variable of statement.declarationList.declarations) {
          if (ts.isIdentifier(variable.name) && variable.initializer) {
            context.variables.set(variable.name.text, variable.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name) {
        context.functions.set(statement.name.text, statement);
      }
    }
    return context;
  }

  contractExpression(node, context, scope = new Map()) {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node)) {
      return `${this.contractExpression(node.expression, context, scope)}.${node.name.text}`;
    }
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
      return JSON.stringify(
        ts.isStringLiteral(node) ? node.text : Number(node.text),
      );
    }
    if (ts.isConditionalExpression(node)) {
      return `(${this.contractExpression(node.condition, context, scope)} ? ${this.contractExpression(node.whenTrue, context, scope)} : ${this.contractExpression(node.whenFalse, context, scope)})`;
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      return `(${this.contractExpression(node.left, context, scope)} ${node.operatorToken.getText(context.file)} ${this.contractExpression(node.right, context, scope)})`;
    }
    if (ts.isIdentifier(node)) {
      const bound = scope.get(node.text);
      if (bound) {
        return this.contractExpression(bound.node, bound.context, bound.scope);
      }
      const imported = context.imports.get(node.text);
      if (imported) {
        if (
          !/^@okouai\/api-contracts(?:\/contracts(?:\/[^.]+)?)?$/.test(
            imported.module,
          )
        ) {
          fail(context, node, "Route metadata must originate in API contracts");
        }
        const key = `${imported.module}:${imported.exported}`;
        let entry = this.contractImports.get(key);
        if (!entry) {
          entry = {
            ...imported,
            alias: `contract${this.contractImports.size}`,
          };
          this.contractImports.set(key, entry);
        }
        return entry.alias;
      }
      const local = context.variables.get(node.text);
      if (local) {
        return this.contractExpression(local, context, scope);
      }
    }
    return fail(
      context,
      node,
      "Unsupported route metadata expression; update the extractor explicitly",
    );
  }

  async extractArrayRoutes(node, context, scope, nextAncestors) {
    const result = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        result.push(
          ...(await this.extractRoutes(
            element.expression,
            context,
            scope,
            nextAncestors,
          )),
        );
      } else if (ts.isObjectLiteralExpression(element)) {
        if (
          element.properties.some((property) => {
            return (
              ts.isSpreadAssignment(property) ||
              (property.name && ts.isComputedPropertyName(property.name))
            );
          })
        ) {
          fail(
            context,
            element,
            "Route registrations require explicit properties without spreads or computed keys",
          );
        }
        const properties = element.properties.filter((property) => {
          return (
            property.name &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name)) &&
            property.name.text === "route"
          );
        });
        const property = properties[0];
        if (properties.length !== 1 || !ts.isPropertyAssignment(property)) {
          fail(
            context,
            element,
            "Expected exactly one explicit route property",
          );
        }
        result.push(
          this.contractExpression(property.initializer, context, scope),
        );
      } else {
        fail(context, element, "Unsupported route registration");
      }
    }
    return result;
  }

  extractFactoryRoutes(node, context, scope, nextAncestors) {
    const factory = context.functions.get(node.expression.text);
    if (!factory?.body) {
      fail(context, node, "Expected a local route factory");
    }
    if (
      factory.body.statements.some((statement) => {
        return (
          !ts.isVariableStatement(statement) && !ts.isReturnStatement(statement)
        );
      })
    ) {
      fail(
        context,
        node,
        "Route factory control flow requires explicit metadata extraction support",
      );
    }
    const returns = factory.body.statements.filter(ts.isReturnStatement);
    if (returns.length !== 1 || !returns[0].expression) {
      fail(context, node, "Route factory requires one unconditional return");
    }
    const factoryScope = new Map(scope);
    for (let index = 0; index < factory.parameters.length; index++) {
      const parameter = factory.parameters[index];
      if (!ts.isIdentifier(parameter.name) || !node.arguments[index]) {
        fail(context, node, "Unsupported route factory parameter");
      }
      factoryScope.set(parameter.name.text, {
        node: node.arguments[index],
        context,
        scope,
      });
    }
    for (const statement of factory.body.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          factoryScope.set(declaration.name.text, {
            node: declaration.initializer,
            context,
            scope: new Map(factoryScope),
          });
        }
      }
    }
    return this.extractRoutes(
      returns[0].expression,
      context,
      factoryScope,
      nextAncestors,
    );
  }

  async extractRoutes(node, context, scope = new Map(), ancestors = new Set()) {
    node = unwrap(node);
    const key = `${context.path}:${node.pos}:${node.end}`;
    if (ancestors.has(key)) {
      fail(context, node, "Cyclic route metadata");
    }
    const nextAncestors = new Set(ancestors).add(key);
    if (ts.isArrayLiteralExpression(node)) {
      return this.extractArrayRoutes(node, context, scope, nextAncestors);
    }
    if (ts.isIdentifier(node)) {
      const local = context.variables.get(node.text);
      if (local) {
        return this.extractRoutes(local, context, scope, nextAncestors);
      }
      const imported = context.imports.get(node.text);
      if (imported?.module.startsWith("./")) {
        const importedPath = resolve(
          dirname(context.path),
          `${imported.module}.ts`,
        );
        if (!importedPath.startsWith(`${routeRoot}/`)) {
          fail(context, node, "Route spread must remain inside route modules");
        }
        const importedContext = await this.loadModule(importedPath);
        const declaration = importedContext.variables.get(imported.exported);
        if (!declaration) {
          fail(context, node, "Missing imported route array");
        }
        return this.extractRoutes(
          declaration,
          importedContext,
          new Map(),
          nextAncestors,
        );
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      return this.extractFactoryRoutes(node, context, scope, nextAncestors);
    }
    return fail(
      context,
      node,
      "Unsupported route array; update the extractor explicitly",
    );
  }
}

async function validateOwnership(extractor) {
  const registry = await extractor.loadModule(
    resolve(apiRoot, "src/signals/route.ts"),
  );
  const original = registry.variables.get("ROUTES");
  if (!original || !ts.isArrayLiteralExpression(original)) {
    throw new Error("Expected the production ROUTES array");
  }
  const originalRecords = original.elements.map((element) => {
    if (!ts.isSpreadElement(element) || !ts.isIdentifier(element.expression)) {
      fail(
        registry,
        element,
        "New production route registration needs explicit ownership",
      );
    }
    const imported = registry.imports.get(element.expression.text);
    if (!imported) {
      fail(registry, element, "Missing production route import");
    }
    return {
      module: `../signals/${imported.module.slice(2)}`,
      exportName: imported.exported,
    };
  });
  if (originalRecords.length !== ROUTE_MODULE_OWNERSHIP.length) {
    throw new Error(
      "Worker ownership does not cover the production route registry",
    );
  }
  for (const [index, record] of ROUTE_MODULE_OWNERSHIP.entries()) {
    if (
      !WORKER_DOMAINS.includes(record.domain) ||
      record.module !== originalRecords[index].module ||
      record.exportName !== originalRecords[index].exportName
    ) {
      throw new Error(
        `Worker ownership diverges from production route order at ${index}: ${record.exportName}`,
      );
    }
  }
  for (const domain of WORKER_DOMAINS) {
    const domainContext = await extractor.loadModule(
      resolve(domainsRoot, `routes-${domain}.ts`),
    );
    const domainRoutes = domainContext.variables.get(
      `${domain.toUpperCase()}_ROUTES`,
    );
    if (!domainRoutes || !ts.isArrayLiteralExpression(domainRoutes)) {
      throw new Error(`Missing ${domain} route array`);
    }
    const actual = domainRoutes.elements.map((element) => {
      if (
        !ts.isSpreadElement(element) ||
        !ts.isIdentifier(element.expression)
      ) {
        fail(
          domainContext,
          element,
          "Domain entries must directly spread owned route imports",
        );
      }
      const imported = domainContext.imports.get(element.expression.text);
      return { module: imported?.module, exportName: imported?.exported };
    });
    const expected = ROUTE_MODULE_OWNERSHIP.filter((record) => {
      return record.domain === domain;
    }).map(({ module, exportName }) => {
      return { module, exportName };
    });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Static ${domain} imports disagree with the ownership registry`,
      );
    }
  }
}

async function evaluateManifest(extractor) {
  const expressions = [];
  for (const record of ROUTE_MODULE_OWNERSHIP) {
    const context = await extractor.loadModule(
      resolve(domainsRoot, `${record.module}.ts`),
    );
    const declaration = context.variables.get(record.exportName);
    if (!declaration) {
      throw new Error(`Missing ${record.exportName}`);
    }
    for (const expression of await extractor.extractRoutes(
      declaration,
      context,
    )) {
      expressions.push(
        `{ route: ${expression}, domain: ${JSON.stringify(record.domain)} }`,
      );
    }
  }
  const imports = [...extractor.contractImports.values()]
    .map(({ module, exported, alias }) => {
      return `import { ${exported} as ${alias} } from ${JSON.stringify(module)};`;
    })
    .join("\n");
  const result = await build({
    absWorkingDir: apiRoot,
    stdin: {
      contents: `${imports}\nexport default [${expressions.join(",\n")}].map(({ route, domain }) => ({ method: route.method, path: route.path, domain }));`,
      resolveDir: apiRoot,
      sourcefile: "worker-route-metadata.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    write: false,
    metafile: true,
  });
  if (
    Object.keys(result.metafile.inputs).some((path) => {
      return path.startsWith("src/");
    })
  ) {
    throw new Error(
      "Gateway route metadata unexpectedly imported API runtime modules",
    );
  }
  const { default: manifest } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
  const keys = new Set();
  for (const entry of manifest) {
    if (
      typeof entry.method !== "string" ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("/") ||
      !WORKER_DOMAINS.includes(entry.domain)
    ) {
      throw new Error("Invalid generated route metadata");
    }
    const key = `${entry.method} ${entry.path}`;
    if (keys.has(key)) {
      throw new Error(`Duplicate API route registration: ${key}`);
    }
    keys.add(key);
  }

  return manifest;
}

// Only contract references are evaluated. Handlers, services, environment and
// database modules are never imported while producing the gateway's plain table.
export async function generateWorkerRouteManifest(outputDirectory) {
  const extractor = new RouteMetadataExtractor();
  await validateOwnership(extractor);
  const manifest = await evaluateManifest(extractor);
  await mkdir(outputDirectory, { recursive: true });
  const json = JSON.stringify(manifest, null, 2);
  await writeFile(resolve(outputDirectory, "route-manifest.json"), `${json}\n`);
  await writeFile(
    resolve(outputDirectory, "route-manifest.ts"),
    `// Generated from the production route contracts; do not edit.\nexport const WORKER_ROUTE_MANIFEST = ${json} as const;\n`,
  );
  return manifest;
}
