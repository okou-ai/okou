import { resolve } from "node:path";

import ts from "typescript";

const CLASS_CALLS = new Set([
  "cc",
  "classNames",
  "clb",
  "clsx",
  "cn",
  "cnb",
  "cva",
  "twJoin",
  "twMerge",
  "tv",
]);
const DOM_CLASS_CALLS = new Set([
  "closest",
  "getElementsByClassName",
  "matches",
  "querySelector",
  "querySelectorAll",
]);

function propertyName(node) {
  return ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
    ? node.text
    : undefined;
}

function classArguments(node) {
  if (
    ts.isJsxAttribute(node) &&
    ["class", "className", "contentClassName"].includes(node.name.getText())
  ) {
    return node.initializer === undefined ? [] : [node.initializer];
  }
  if (
    ts.isPropertyAssignment(node) &&
    ["class", "className", "contentClassName"].includes(propertyName(node.name))
  ) {
    return [node.initializer];
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === "className"
  ) {
    return [node.right];
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    const classListCall =
      ts.isPropertyAccessExpression(callee) &&
      ts.isPropertyAccessExpression(callee.expression) &&
      callee.expression.name.text === "classList";
    if (CLASS_CALLS.has(name) || DOM_CLASS_CALLS.has(name) || classListCall) {
      return [...node.arguments];
    }
  }
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === "tw") {
    return [node.template];
  }
  return undefined;
}

function initializerForReference(node, checker) {
  let symbol = checker.getSymbolAtLocation(node);
  if (ts.isElementAccessExpression(node)) {
    const key = checker.getTypeAtLocation(node.argumentExpression);
    if (key.isStringLiteral() || key.isNumberLiteral()) {
      symbol = checker.getPropertyOfType(
        checker.getTypeAtLocation(node.expression),
        String(key.value),
      );
    }
  }
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration;
  if (declaration !== undefined && ts.isExportAssignment(declaration)) {
    return declaration.expression;
  }
  if (
    declaration !== undefined &&
    ts.isBindingElement(declaration) &&
    ts.isVariableDeclaration(declaration.parent.parent) &&
    declaration.parent.parent.initializer !== undefined
  ) {
    const key = ts.isArrayBindingPattern(declaration.parent)
      ? String(declaration.parent.elements.indexOf(declaration))
      : propertyName(declaration.propertyName ?? declaration.name);
    if (key !== undefined) {
      const source = checker.getTypeAtLocation(
        declaration.parent.parent.initializer,
      );
      return checker.getPropertyOfType(source, key)?.valueDeclaration
        ?.initializer;
    }
  }
  if (
    declaration !== undefined &&
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isBindingElement(declaration))
  ) {
    return declaration.initializer;
  }
  return undefined;
}

function collectStrings(node, checker, record, ancestors = new Set()) {
  // Cyclic aliases are not strings. Keep the guard path-local so separate
  // consumers of the same constant are still counted independently.
  if (ancestors.has(node)) {
    return;
  }
  const path = new Set(ancestors).add(node);
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    record(node.text);
    return;
  }
  if (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const initializer = initializerForReference(node, checker);
    if (initializer !== undefined) {
      collectStrings(initializer, checker, record, path);
    } else {
      // Tuple elements and declared literal properties have a bound value but
      // no valueDeclaration initializer in the compiler's symbol table.
      const type = checker.getTypeAtLocation(node);
      for (const member of type.isUnion() ? type.types : [type]) {
        if (member.isStringLiteral()) {
          record(member.value);
        }
      }
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectStrings(node.whenTrue, checker, record, path);
    collectStrings(node.whenFalse, checker, record, path);
    return;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    collectStrings(node.right, checker, record, path);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    if (ts.isComputedPropertyName(node.name)) {
      collectStrings(node.name.expression, checker, record, path);
    } else {
      record(node.name.text);
    }
    collectStrings(node.initializer, checker, record, path);
    return;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    record(node.name.text);
    return;
  }
  if (ts.isCallExpression(node)) {
    // Class factories can themselves be constants (for example cva(...)).
    const initializer = initializerForReference(node.expression, checker);
    if (
      initializer !== undefined &&
      ts.isCallExpression(initializer) &&
      CLASS_CALLS.has(initializer.expression.getText())
    ) {
      collectStrings(initializer, checker, record, path);
    }
    for (const argument of node.arguments) {
      collectStrings(argument, checker, record, path);
    }
    return;
  }
  ts.forEachChild(node, (child) =>
    collectStrings(child, checker, record, path),
  );
}

function classStringContents(sourceFile, checker) {
  const contents = [];
  function visit(node) {
    const argumentsToCollect = classArguments(node);
    if (argumentsToCollect !== undefined) {
      for (const argument of argumentsToCollect) {
        collectStrings(argument, checker, (text) => contents.push(text));
      }
      // A cn() call nested inside className is the same consumer, not a second
      // dependency. Separate class attributes each traverse their aliases.
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return contents;
}

function countClassTokens(contents, tokens) {
  const counts = {};
  for (const token of tokens) {
    let count = 0;
    for (const content of contents) {
      let offset = content.indexOf(token);
      while (offset !== -1) {
        const before = content.charAt(offset - 1);
        const after = content.charAt(offset + token.length);
        if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
          count += 1;
        }
        offset = content.indexOf(token, offset + Math.max(token.length, 1));
      }
    }
    if (count > 0) {
      counts[token] = count;
    }
  }
  return counts;
}

export function collectClassUsages(root, files, tokens) {
  // Bind the in-scope source graph for lexical scopes, imports, and re-exports.
  // No type checking or dependency/library loading is needed for initializers.
  const program = ts.createProgram(
    files.map((file) => resolve(root, file)),
    {
      noLib: true,
      noResolve: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  );
  const checker = program.getTypeChecker();
  const usages = {};
  for (const file of files) {
    const source = program.getSourceFile(resolve(root, file));
    const counts = countClassTokens(
      classStringContents(source, checker),
      tokens,
    );
    if (Object.keys(counts).length > 0) {
      usages[file] = counts;
    }
  }
  return usages;
}
