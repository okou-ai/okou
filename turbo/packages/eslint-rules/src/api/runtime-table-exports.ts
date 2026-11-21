import { fileURLToPath } from "node:url";
import ts from "typescript";

const runtimeTableExports = new Map<string, ReadonlySet<string>>();

function readTableExports(moduleName: string): ReadonlySet<string> {
  const path = fileURLToPath(
    new URL(`../../../db/src/runtime/${moduleName}.ts`, import.meta.url),
  );
  const text = ts.sys.readFile(path);
  const tables = new Set<string>();
  if (text === undefined) {
    return tables;
  }

  const { statements } = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
  );
  const factories = new Set<string>();
  for (const statement of statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "drizzle-orm/pg-core" ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (
          !binding.isTypeOnly &&
          (binding.propertyName ?? binding.name).text === "pgTable"
        ) {
          factories.add(binding.name.text);
        }
      }
    }
  }

  for (const statement of statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    for (const { name, initializer } of statement.declarationList
      .declarations) {
      if (
        ts.isIdentifier(name) &&
        initializer &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        factories.has(initializer.expression.text)
      ) {
        tables.add(name.text);
      }
    }
  }
  return tables;
}

/** Accept direct exported Drizzle tables, including in modules that also export helpers. */
export function isRuntimeTableExport(
  source: string,
  exportName: string,
): boolean {
  const match = /^@okouai\/db\/runtime\/([a-z0-9-]+)$/u.exec(source);
  if (!match) {
    return false;
  }
  const moduleName = match[1];
  let tables = runtimeTableExports.get(moduleName);
  if (tables === undefined) {
    tables = readTableExports(moduleName);
    runtimeTableExports.set(moduleName, tables);
  }
  return tables.has(exportName);
}
