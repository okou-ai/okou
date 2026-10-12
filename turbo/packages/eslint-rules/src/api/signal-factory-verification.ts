import { dirname, resolve, sep } from "node:path";
import ts from "typescript";

interface ImportedBinding {
  readonly source: string;
  readonly name: string;
}

interface ModuleDeclarations {
  readonly path: string;
  readonly imports: ReadonlyMap<string, ImportedBinding>;
  readonly typeImports: ReadonlyMap<string, ImportedBinding>;
  readonly functions: ReadonlyMap<string, ts.FunctionDeclaration>;
  readonly interfaces: ReadonlyMap<string, ts.InterfaceDeclaration>;
  readonly writtenNames: ReadonlySet<string>;
}

/** Fields proven to be own data properties of a freshly constructed record. */
export interface ComputedFactoryArgument {
  readonly recordFields?: readonly string[];
}

type VerifiedFactory =
  | { readonly kind: "computed" }
  | { readonly kind: "computed-record"; readonly fields: readonly string[] };

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
export function createComputedFactoryVerifier(importerPath: string) {
  const apiRootMarker = `${sep}turbo${sep}apps${sep}api${sep}`;
  const apiRootIndex = importerPath.indexOf(apiRootMarker);
  const bootstrapPath =
    apiRootIndex === -1
      ? undefined
      : resolve(
          importerPath.slice(0, apiRootIndex),
          "turbo/apps/api/src/signals/services/agent-run-context.signals.ts",
        );
  const modules = new Map<string, ModuleDeclarations | null>();
  const checked = new Map<
    ts.FunctionDeclaration,
    Map<string, VerifiedFactory | null>
  >();
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
      const typeImports = new Map<string, ImportedBinding>();
      const functions = new Map<string, ts.FunctionDeclaration>();
      const interfaces = new Map<string, ts.InterfaceDeclaration>();
      for (const statement of parsed.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)
        ) {
          for (const binding of statement.importClause.namedBindings.elements) {
            const imported = {
              source: statement.moduleSpecifier.text,
              name: binding.propertyName?.text ?? binding.name.text,
            };
            typeImports.set(binding.name.text, imported);
            if (!statement.importClause.isTypeOnly && !binding.isTypeOnly) {
              imports.set(binding.name.text, imported);
            }
          }
        } else if (ts.isFunctionDeclaration(statement) && statement.name) {
          functions.set(statement.name.text, statement);
        } else if (ts.isInterfaceDeclaration(statement)) {
          interfaces.set(statement.name.text, statement);
        }
      }
      const module = {
        path,
        imports,
        typeImports,
        functions,
        interfaces,
        writtenNames: writtenBindingNames(parsed),
      };
      modules.set(path, module);
      return module;
    }
    return null;
  }

  function bootstrapIdentityFields(
    module: ModuleDeclarations,
    parameter: ts.ParameterDeclaration,
  ): readonly string[] | undefined {
    if (
      !parameter.type ||
      !ts.isTypeReferenceNode(parameter.type) ||
      !ts.isIdentifier(parameter.type.typeName)
    ) {
      return undefined;
    }
    const imported = module.typeImports.get(parameter.type.typeName.text);
    if (imported?.name !== "AgentRunContextSignals") {
      return undefined;
    }
    const owner = readModule(module.path, imported.source);
    if (!owner || owner.path !== bootstrapPath) {
      return undefined;
    }
    const declaration = owner.interfaces.get(imported.name);
    const fields = ["userId", "orgId", "agentId"];
    // The API's existing cross-graph bootstrap contract owns these three plain
    // strings. This exception does not authorize signal getters or other types.
    return declaration &&
      fields.every((name) => {
        return declaration.members.some((member) => {
          return (
            ts.isPropertySignature(member) &&
            recordPropertyName(member.name) === name &&
            member.type?.kind === ts.SyntaxKind.StringKeyword &&
            !member.questionToken &&
            member.modifiers?.some((modifier) => {
              return modifier.kind === ts.SyntaxKind.ReadonlyKeyword;
            })
          );
        });
      })
      ? fields
      : undefined;
  }

  function verifyImported(
    importer: string,
    source: string,
    name: string,
    args: readonly ComputedFactoryArgument[] = [],
  ) {
    const module = readModule(importer, source);
    const declaration = module?.functions.get(name);
    return module &&
      declaration?.modifiers?.some((modifier) => {
        return modifier.kind === ts.SyntaxKind.ExportKeyword;
      })
      ? verifyFunction(module, declaration, args)
      : null;
  }

  function verifyFunction(
    module: ModuleDeclarations,
    fn: ts.FunctionDeclaration,
    args: readonly ComputedFactoryArgument[],
  ): VerifiedFactory | null {
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
      return null;
    }
    visiting.add(fn);
    const localNames = new Set(
      fn.parameters.map((parameter) => parameter.name.getText()),
    );
    const nodes = new Set<string>();
    const records = new Map<string, readonly string[]>();
    const computedRecords = new Map<string, readonly string[]>();
    function collectLocalNames(name: ts.BindingName): void {
      if (ts.isIdentifier(name)) {
        localNames.add(name.text);
      } else {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) {
            collectLocalNames(element.name);
          }
        }
      }
    }
    fn.parameters.forEach((parameter, index) => {
      const fields =
        args[index]?.recordFields ?? bootstrapIdentityFields(module, parameter);
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
          collectLocalNames(declaration.name);
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

    function verifiedValue(expression: ts.Expression): VerifiedFactory | null {
      const node = passiveValue(expression);
      if (ts.isIdentifier(node) && !module.writtenNames.has(node.text)) {
        if (nodes.has(node.text)) {
          return { kind: "computed" };
        }
        const fields = computedRecords.get(node.text);
        return fields ? { kind: "computed-record", fields } : null;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        !module.writtenNames.has(node.expression.text) &&
        computedRecords.get(node.expression.text)?.includes(node.name.text)
      ) {
        return { kind: "computed" };
      }
      if (ts.isObjectLiteralExpression(node)) {
        const fields = computedRecordFields(node);
        return fields ? { kind: "computed-record", fields } : null;
      }
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
        return null;
      }
      const name = node.expression.text;
      if (localNames.has(name)) {
        return null;
      }
      const imported = module.imports.get(name);
      if (imported?.source === "ccstate" && imported.name === "computed") {
        const [callback] = node.arguments;
        return node.arguments.length === 1 &&
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
          ? { kind: "computed" }
          : null;
      }
      const shapes = node.arguments.map(argumentShape);
      if (shapes.some((shape) => shape === null)) {
        return null;
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
      return nested ? verifyFunction(module, nested, args) : null;
    }

    function isComputedNode(node: ts.Expression): boolean {
      return verifiedValue(node)?.kind === "computed";
    }

    function computedRecordFields(
      node: ts.ObjectLiteralExpression,
    ): readonly string[] | null {
      const fields: string[] = [];
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property)
        ) {
          return null;
        }
        const name = recordPropertyName(property.name);
        if (
          name === undefined ||
          name === "__proto__" ||
          (ts.isShorthandPropertyAssignment(property) &&
            property.objectAssignmentInitializer) ||
          !isComputedNode(
            ts.isPropertyAssignment(property)
              ? property.initializer
              : property.name,
          )
        ) {
          return null;
        }
        fields.push(name);
      }
      return fields;
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

    function isFlatRecordDestructure(
      declaration: ts.VariableDeclaration,
    ): boolean {
      if (
        !ts.isObjectBindingPattern(declaration.name) ||
        !declaration.initializer
      ) {
        return false;
      }
      const fields = argumentShape(declaration.initializer)?.recordFields;
      return (
        fields !== undefined &&
        declaration.name.elements.every((element) => {
          const name = element.propertyName
            ? recordPropertyName(element.propertyName)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
          return (
            ts.isIdentifier(element.name) &&
            !module.writtenNames.has(element.name.text) &&
            !element.initializer &&
            !element.dotDotDotToken &&
            name !== undefined &&
            fields.includes(name)
          );
        })
      );
    }

    const statements = [...fn.body.statements];
    const returned = statements.pop();
    const declarationsOnly = statements.every((statement) => {
      return (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        statement.declarationList.declarations.every((declaration) => {
          if (isFlatRecordDestructure(declaration)) {
            return true;
          }
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            return false;
          }
          const verified = verifiedValue(declaration.initializer);
          if (verified?.kind === "computed") {
            nodes.add(declaration.name.text);
            return true;
          }
          if (
            ts.isPropertyAccessExpression(declaration.initializer) &&
            argumentShape(declaration.initializer) !== null &&
            !module.writtenNames.has(declaration.name.text)
          ) {
            return true;
          }
          const fields =
            verified?.kind === "computed-record"
              ? verified.fields
              : recordFields(declaration.initializer);
          if (
            fields === undefined ||
            module.writtenNames.has(declaration.name.text)
          ) {
            return false;
          }
          records.set(declaration.name.text, fields);
          if (verified?.kind === "computed-record") {
            computedRecords.set(declaration.name.text, fields);
          }
          return true;
        })
      );
    });
    const result =
      declarationsOnly &&
      returned !== undefined &&
      ts.isReturnStatement(returned) &&
      returned.expression !== undefined
        ? verifiedValue(returned.expression)
        : null;
    visiting.delete(fn);
    const results =
      checked.get(fn) ?? new Map<string, VerifiedFactory | null>();
    results.set(signature, result);
    checked.set(fn, results);
    return result;
  }

  return verifyImported;
}
