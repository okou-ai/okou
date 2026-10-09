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

/** Fields proven to be own data properties of a freshly constructed record. */
export interface ComputedFactoryArgument {
  readonly recordFields?: readonly string[];
}

function passiveValue(node: ts.Expression): ts.Expression {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return passiveValue(node.expression);
  }
  return node;
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
  return false;
}

function recordPropertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
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
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      target(node.expression);
    } else if (
      ts.isSpreadElement(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
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
    } else if (ts.isDeleteExpression(node)) {
      target(node.expression);
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
  const checked = new Map<ts.FunctionDeclaration, Map<string, boolean>>();
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

  function verifyImported(
    importer: string,
    source: string,
    name: string,
    args: readonly ComputedFactoryArgument[] = [],
  ) {
    const module = readModule(importer, source);
    const declaration = module?.functions.get(name);
    return Boolean(
      module &&
      declaration?.modifiers?.some((modifier) => {
        return modifier.kind === ts.SyntaxKind.ExportKeyword;
      }) &&
      verifyFunction(module, declaration, args),
    );
  }

  function verifyFunction(
    module: ModuleDeclarations,
    fn: ts.FunctionDeclaration,
    args: readonly ComputedFactoryArgument[],
  ): boolean {
    const signature = JSON.stringify(
      args.map((argument) =>
        argument.recordFields ? [...argument.recordFields].sort() : null,
      ),
    );
    const prior = checked.get(fn)?.get(signature);
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
    const records = new Map<string, readonly string[]>();
    fn.parameters.forEach((parameter, index) => {
      const fields = args[index]?.recordFields;
      if (
        fields !== undefined &&
        !module.writtenNames.has(parameter.name.getText())
      ) {
        records.set(parameter.name.getText(), fields);
      }
    });
    for (const statement of fn.body.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          localNames.add(declaration.name.getText());
        }
      }
    }

    function argumentShape(
      node: ts.Expression,
    ): ComputedFactoryArgument | null {
      const value = passiveValue(node);
      if (isPassiveValue(value)) {
        const fields = ts.isIdentifier(value)
          ? records.get(value.text)
          : undefined;
        return fields === undefined ? {} : { recordFields: fields };
      }
      if (
        ts.isPropertyAccessExpression(value) &&
        ts.isIdentifier(value.expression) &&
        !module.writtenNames.has(value.expression.text) &&
        records.get(value.expression.text)?.includes(value.name.text)
      ) {
        return {};
      }
      // Unknown objects may have getters. Only proven flat records permit
      // property reads; asserted parameter types cannot establish that fact.
      return null;
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
      const shapes = node.arguments.map(argumentShape);
      if (shapes.some((shape) => shape === null)) {
        return false;
      }
      const args = shapes.filter((shape) => shape !== null);
      if (imported) {
        return verifyImported(
          module.path,
          imported.source,
          imported.name,
          args,
        );
      }
      const nested = module.functions.get(name);
      return nested !== undefined && verifyFunction(module, nested, args);
    }

    function recordFields(node: ts.Expression): readonly string[] | undefined {
      const value = passiveValue(node);
      if (!ts.isObjectLiteralExpression(value)) {
        return undefined;
      }
      const fields: string[] = [];
      for (const property of value.properties) {
        if (
          !ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property)
        ) {
          return undefined;
        }
        const name = recordPropertyName(property.name);
        if (name === undefined || name === "__proto__") {
          return undefined;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          if (property.objectAssignmentInitializer) {
            return undefined;
          }
        } else if (
          argumentShape(property.initializer) === null &&
          !isComputedNode(property.initializer)
        ) {
          return undefined;
        }
        fields.push(name);
      }
      return fields;
    }

    const statements = [...fn.body.statements];
    const returned = statements.pop();
    const declarationsOnly = statements.every((statement) => {
      return (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        statement.declarationList.declarations.every((declaration) => {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            return false;
          }
          if (isComputedNode(declaration.initializer)) {
            nodes.add(declaration.name.text);
            return true;
          }
          const fields = recordFields(declaration.initializer);
          if (
            fields === undefined ||
            module.writtenNames.has(declaration.name.text)
          ) {
            return false;
          }
          records.set(declaration.name.text, fields);
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
    const results = checked.get(fn) ?? new Map<string, boolean>();
    results.set(signature, result);
    checked.set(fn, results);
    return result;
  }

  return verifyImported;
}
