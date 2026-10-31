import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

import ts from "typescript";

export interface ClientContractImportBinding {
  readonly name: string;
  readonly source: string;
  readonly imported: string;
}

export interface ClientContractImportModule {
  readonly module: string;
  readonly contracts: readonly string[];
  readonly bindings: readonly ClientContractImportBinding[];
}

interface ContractModuleExports {
  readonly module: string;
  readonly contracts: readonly { readonly name: string }[];
}

interface Definition {
  readonly file: string;
  readonly name: string;
}

type Binding =
  | { readonly kind: "unknown" }
  | { readonly kind: "definition" }
  | { readonly kind: "local"; readonly name: string }
  | { readonly kind: "import"; readonly file: string; readonly name: string };

interface SourceBindings {
  readonly locals: ReadonlyMap<string, Binding>;
  readonly exports: ReadonlyMap<string, Binding>;
  readonly stars: readonly string[];
  readonly unknownStars: boolean;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => {
      return modifier.kind === kind;
    }) === true
  );
}

function aliasIdentifier(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  // Assertions and annotations can change the exported type even when the
  // runtime value is identical. Follow only type-preserving identifier aliases.
  if (ts.isParenthesizedExpression(expression)) {
    return aliasIdentifier(expression.expression);
  }
  return undefined;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) => {
    return ts.isOmittedExpression(element) ? [] : bindingNames(element.name);
  });
}

function definitionKey({ file, name }: Definition): string {
  return JSON.stringify([file, name]);
}

/** Resolve source bindings, never schema values or runtime object identity. */
export async function discoverClientContractImportModules({
  modules,
  sourceDirectory,
}: {
  modules: readonly ContractModuleExports[];
  sourceDirectory: string;
}): Promise<ClientContractImportModule[]> {
  const contractsDirectory = resolve(sourceDirectory);
  const validatorsDirectory = resolve(sourceDirectory, "../validators");
  const sources = new Map<string, Promise<SourceBindings | undefined>>();

  function packageSource(file: string): string | undefined {
    for (const [directory, prefix] of [
      [contractsDirectory, "contracts"],
      [validatorsDirectory, "validators"],
    ] as const) {
      const subpath = relative(directory, file);
      if (
        subpath !== "" &&
        subpath !== ".." &&
        !subpath.startsWith(`..${sep}`) &&
        !subpath.startsWith(sep) &&
        subpath.endsWith(".ts") &&
        !subpath.endsWith(".d.ts") &&
        !subpath.endsWith(".test.ts")
      ) {
        return `${prefix}/${subpath.slice(0, -3).split(sep).join("/")}`;
      }
    }
    return undefined;
  }

  function importedFile(
    file: string,
    specifier: ts.Expression,
  ): string | undefined {
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) {
      return undefined;
    }
    const path = resolve(dirname(file), specifier.text);
    const extension = extname(path);
    const resolved =
      extension === ".ts" || extension === ".js"
        ? `${path.slice(0, -extension.length)}.ts`
        : extension === ""
          ? `${path}.ts`
          : undefined;
    return resolved !== undefined && packageSource(resolved) !== undefined
      ? resolved
      : undefined;
  }

  function parseImportDeclaration(
    file: string,
    statement: ts.ImportDeclaration,
    locals: Map<string, Binding>,
  ): void {
    const clause = statement.importClause;
    const target = importedFile(file, statement.moduleSpecifier);
    if (clause === undefined || clause.isTypeOnly || target === undefined) {
      return;
    }
    if (clause.name !== undefined) {
      locals.set(clause.name.text, {
        kind: "import",
        file: target,
        name: "default",
      });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) {
          locals.set(element.name.text, {
            kind: "import",
            file: target,
            name: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
  }

  function parseExportDeclaration(
    file: string,
    statement: ts.ExportDeclaration,
    exports: Map<string, Binding>,
    stars: string[],
  ): boolean {
    const target = statement.moduleSpecifier
      ? importedFile(file, statement.moduleSpecifier)
      : undefined;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          const name = (element.propertyName ?? element.name).text;
          exports.set(
            element.name.text,
            target !== undefined
              ? { kind: "import", file: target, name }
              : statement.moduleSpecifier === undefined
                ? { kind: "local", name }
                : { kind: "unknown" },
          );
        }
      }
    } else if (statement.exportClause === undefined) {
      if (target === undefined) {
        return true;
      }
      stars.push(target);
    } else if (ts.isNamespaceExport(statement.exportClause)) {
      exports.set(statement.exportClause.name.text, { kind: "unknown" });
    }
    return false;
  }

  function parseVariableStatement(
    statement: ts.VariableStatement,
    locals: Map<string, Binding>,
    exports: Map<string, Binding>,
  ): void {
    const immutable =
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        for (const name of bindingNames(declaration.name)) {
          locals.set(name, { kind: "unknown" });
          if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
            exports.set(name, { kind: "local", name });
          }
        }
        continue;
      }
      const name = declaration.name.text;
      const alias =
        declaration.initializer && declaration.type === undefined
          ? aliasIdentifier(declaration.initializer)
          : undefined;
      locals.set(
        name,
        !immutable || declaration.initializer === undefined
          ? { kind: "unknown" }
          : alias === undefined
            ? { kind: "definition" }
            : { kind: "local", name: alias },
      );
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        exports.set(name, { kind: "local", name });
      }
    }
  }

  /** Return whether the statement contains an unresolved star export. */
  function parseStatement(
    file: string,
    statement: ts.Statement,
    locals: Map<string, Binding>,
    exports: Map<string, Binding>,
    stars: string[],
  ): boolean {
    if (ts.isImportDeclaration(statement)) {
      parseImportDeclaration(file, statement, locals);
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      return parseExportDeclaration(file, statement, exports, stars);
    } else if (ts.isVariableStatement(statement)) {
      parseVariableStatement(statement, locals, exports);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined &&
      !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
    ) {
      const name = statement.name.text;
      locals.set(name, { kind: "definition" });
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        exports.set(
          hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
            ? "default"
            : name,
          { kind: "local", name },
        );
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const name = aliasIdentifier(statement.expression);
      if (name !== undefined) {
        exports.set("default", { kind: "local", name });
      }
    }
    return false;
  }

  async function parseSource(
    file: string,
  ): Promise<SourceBindings | undefined> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    const source = ts.createSourceFile(
      file,
      text,
      {
        languageVersion: ts.ScriptTarget.Latest,
        jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
      },
      false,
      ts.ScriptKind.TS,
    );
    const locals = new Map<string, Binding>();
    const exports = new Map<string, Binding>();
    const stars: string[] = [];
    let unknownStars = false;
    for (const statement of source.statements) {
      if (parseStatement(file, statement, locals, exports, stars)) {
        unknownStars = true;
      }
    }
    return { locals, exports, stars, unknownStars };
  }

  function loadSource(file: string): Promise<SourceBindings | undefined> {
    let source = sources.get(file);
    if (source === undefined) {
      source = parseSource(file);
      sources.set(file, source);
    }
    return source;
  }

  async function exportNames(
    file: string,
    visited = new Set<string>(),
  ): Promise<string[]> {
    if (visited.has(file)) {
      return [];
    }
    const source = await loadSource(file);
    if (source === undefined) {
      return [];
    }
    const next = new Set(visited).add(file);
    const names = new Set(source.exports.keys());
    for (const star of source.stars) {
      for (const name of await exportNames(star, next)) {
        if (name !== "default") {
          names.add(name);
        }
      }
    }
    return [...names].sort(compareNames);
  }

  async function resolveBinding(
    file: string,
    name: string,
    exported: boolean,
    visited = new Set<string>(),
  ): Promise<Definition | "unknown" | undefined> {
    const key = JSON.stringify([file, name, exported]);
    if (visited.has(key)) {
      return undefined;
    }
    const source = await loadSource(file);
    if (source === undefined) {
      return undefined;
    }
    const next = new Set(visited).add(key);
    const binding = (exported ? source.exports : source.locals).get(name);
    if (binding?.kind === "unknown") {
      return "unknown";
    }
    if (binding?.kind === "definition") {
      return { file, name };
    }
    if (binding?.kind === "local") {
      return (
        (await resolveBinding(file, binding.name, false, next)) ?? "unknown"
      );
    }
    if (binding?.kind === "import") {
      return (
        (await resolveBinding(binding.file, binding.name, true, next)) ??
        "unknown"
      );
    }
    if (!exported) {
      return "unknown";
    }
    if (name === "default") {
      return undefined;
    }
    return resolveStarBinding(source, name, next);
  }

  async function resolveStarBinding(
    source: SourceBindings,
    name: string,
    visited: Set<string>,
  ): Promise<Definition | "unknown" | undefined> {
    if (source.unknownStars) {
      return "unknown";
    }
    let found: Definition | undefined;
    for (const star of source.stars) {
      const candidate = await resolveBinding(star, name, true, visited);
      if (candidate === "unknown") {
        return "unknown";
      }
      if (candidate !== undefined) {
        if (
          found !== undefined &&
          definitionKey(found) !== definitionKey(candidate)
        ) {
          return undefined;
        }
        found = candidate;
      }
    }
    return found;
  }

  const routerDefinitions = new Set<string>();
  const routerFiles = new Set(
    modules.map(({ module }) => {
      return resolve(contractsDirectory, `${module}.ts`);
    }),
  );
  for (const { module, contracts } of modules) {
    for (const { name } of contracts) {
      const definition = await resolveBinding(
        resolve(contractsDirectory, `${module}.ts`),
        name,
        true,
      );
      if (definition !== undefined && definition !== "unknown") {
        routerDefinitions.add(definitionKey(definition));
        routerFiles.add(definition.file);
      }
    }
  }

  const independentExports = new Map<
    string,
    Promise<ReadonlyMap<string, string>>
  >();
  async function definingExports(
    file: string,
  ): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    if (routerFiles.has(file) || packageSource(file) === "contracts/index") {
      return names;
    }
    for (const exported of await exportNames(file)) {
      const definition = await resolveBinding(file, exported, true);
      if (definition === undefined || definition === "unknown") {
        continue;
      }
      const key = definitionKey(definition);
      if (routerDefinitions.has(key)) {
        return new Map<string, string>();
      }
      if (
        definition.file === file &&
        (!names.has(key) || exported === definition.name)
      ) {
        names.set(key, exported);
      }
    }
    return names;
  }

  const result: ClientContractImportModule[] = [];
  for (const { module, contracts } of [...modules].sort((left, right) => {
    return compareNames(left.module, right.module);
  })) {
    const file = resolve(contractsDirectory, `${module}.ts`);
    const contractNames = contracts
      .map(({ name }) => {
        return name;
      })
      .sort(compareNames);
    const bindings: ClientContractImportBinding[] = [];
    for (const name of await exportNames(file)) {
      if (contractNames.includes(name)) {
        continue;
      }
      const definition = await resolveBinding(file, name, true);
      if (definition === undefined || definition === "unknown") {
        continue;
      }
      const source = packageSource(definition.file);
      if (source === undefined) {
        continue;
      }
      let exports = independentExports.get(definition.file);
      if (exports === undefined) {
        exports = definingExports(definition.file);
        independentExports.set(definition.file, exports);
      }
      const imported = (await exports).get(definitionKey(definition));
      if (imported !== undefined) {
        bindings.push({ name, source, imported });
      }
    }
    result.push({ module, contracts: contractNames, bindings });
  }
  return result;
}
