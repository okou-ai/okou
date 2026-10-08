import { dirname, resolve } from "node:path";
import ts from "typescript";

interface ImportedBinding {
  readonly source: string;
  readonly name: string;
}

interface ModuleDeclarations {
  readonly path: string;
  readonly imports: ReadonlyMap<string, ImportedBinding>;
  readonly functions: ReadonlyMap<string, ts.FunctionDeclaration>;
  readonly writtenNames: ReadonlySet<string>;
}

function isPassiveValue(node: ts.Expression): boolean {
  if (
    ts.isIdentifier(node) ||
    ts.isLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isPassiveValue(node.expression);
  }
  // Factories connect already constructed nodes or ordinary values. Calls,
  // property accessors, spreads and defaults cannot execute during connection.
  return false;
}

function writtenBindingNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  function target(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(target);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          target(property.name);
        } else if (ts.isPropertyAssignment(property)) {
          target(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          target(property.expression);
        }
      }
    } else if (ts.isSpreadElement(node) || ts.isParenthesizedExpression(node)) {
      target(node.expression);
    }
  }
  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      target(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      target(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      target(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names;
}

/** Verify source declarations, never factory names or asserted return types. */
export function createComputedFactoryVerifier() {
  const modules = new Map<string, ModuleDeclarations | null>();
  const checked = new Map<ts.FunctionDeclaration, boolean>();
  const visiting = new Set<ts.FunctionDeclaration>();

  function readModule(importer: string, source: string) {
    if (!source.startsWith(".")) {
      return null;
    }
    const target = resolve(dirname(importer), source);
    for (const path of [target, `${target}.ts`, `${target}.tsx`]) {
      if (modules.has(path)) {
        const module = modules.get(path);
        if (module) {
          return module;
        }
        continue;
      }
      const text = ts.sys.readFile(path);
      if (text === undefined) {
        modules.set(path, null);
        continue;
      }
      const parsed = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const imports = new Map<string, ImportedBinding>();
      const functions = new Map<string, ts.FunctionDeclaration>();
      for (const statement of parsed.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          !statement.importClause?.isTypeOnly &&
          statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)
        ) {
          for (const binding of statement.importClause.namedBindings.elements) {
            if (!binding.isTypeOnly) {
              imports.set(binding.name.text, {
                source: statement.moduleSpecifier.text,
                name: binding.propertyName?.text ?? binding.name.text,
              });
            }
          }
        } else if (ts.isFunctionDeclaration(statement) && statement.name) {
          functions.set(statement.name.text, statement);
        }
      }
      const module = {
        path,
        imports,
        functions,
        writtenNames: writtenBindingNames(parsed),
      };
      modules.set(path, module);
      return module;
    }
    return null;
  }

  function verifyImported(importer: string, source: string, name: string) {
    const module = readModule(importer, source);
    const declaration = module?.functions.get(name);
    return Boolean(
      module &&
      declaration?.modifiers?.some((modifier) => {
        return modifier.kind === ts.SyntaxKind.ExportKeyword;
      }) &&
      verifyFunction(module, declaration),
    );
  }

  function verifyFunction(
    module: ModuleDeclarations,
    fn: ts.FunctionDeclaration,
  ): boolean {
    const prior = checked.get(fn);
    if (prior !== undefined) {
      return prior;
    }
    if (
      visiting.has(fn) ||
      (fn.name !== undefined && module.writtenNames.has(fn.name.text)) ||
      !fn.body ||
      fn.asteriskToken ||
      fn.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) ||
      fn.parameters.some((parameter) => {
        return (
          !ts.isIdentifier(parameter.name) ||
          parameter.initializer ||
          parameter.dotDotDotToken
        );
      })
    ) {
      return false;
    }
    visiting.add(fn);
    const localNames = new Set(
      fn.parameters.map((parameter) => parameter.name.getText()),
    );
    const nodes = new Set<string>();
    for (const statement of fn.body.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          localNames.add(declaration.name.getText());
        }
      }
    }

    function isComputedNode(node: ts.Expression): boolean {
      if (ts.isIdentifier(node)) {
        return nodes.has(node.text);
      }
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
        return false;
      }
      const name = node.expression.text;
      if (localNames.has(name)) {
        return false;
      }
      const imported = module.imports.get(name);
      if (imported?.source === "ccstate" && imported.name === "computed") {
        const [callback] = node.arguments;
        return (
          node.arguments.length === 1 &&
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        );
      }
      if (!node.arguments.every(isPassiveValue)) {
        return false;
      }
      if (imported) {
        return verifyImported(module.path, imported.source, imported.name);
      }
      const nested = module.functions.get(name);
      return nested !== undefined && verifyFunction(module, nested);
    }

    const statements = [...fn.body.statements];
    const returned = statements.pop();
    const declarationsOnly = statements.every((statement) => {
      return (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        statement.declarationList.declarations.every((declaration) => {
          if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !isComputedNode(declaration.initializer)
          ) {
            return false;
          }
          nodes.add(declaration.name.text);
          return true;
        })
      );
    });
    const result =
      declarationsOnly &&
      returned !== undefined &&
      ts.isReturnStatement(returned) &&
      returned.expression !== undefined &&
      isComputedNode(returned.expression);
    visiting.delete(fn);
    checked.set(fn, result);
    return result;
  }

  return verifyImported;
}
