import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fork } from "@eslint/css-tree";
import { parse } from "parse5";
import { tailwind4 } from "tailwind-csstree";
import ts from "typescript";

const css = fork(tailwind4);
const printer = ts.createPrinter({ removeComments: true });
const utility =
  /(?:^|:)(?:!?-?z-(?:\d+(?:\.\d+)?|auto|\[[^\s]+\]|\([^\s]+\))!?|!?\[z-index:[^\s]+\]!?)$/;
const roots = ["apps/platform/src", "packages/ui/src"];

export function isStackingSource(file) {
  return (
    file === "apps/platform/index.html" ||
    (roots.some((root) => file.startsWith(`${root}/`)) &&
      /\.(?:[cm]?[jt]sx?|css|html)$/.test(file) &&
      !/(?:^|\/)(?:__tests__|__snapshots__|__mocks__|tests?|mocks?|test-fixtures|node_modules)\//.test(
        file,
      ) &&
      !/\.(?:test|spec|stories)\.[^.]+$/.test(file))
  );
}

function sourceScope(node) {
  const names = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isVariableDeclaration(parent)) &&
      parent.name
    ) {
      names.unshift(parent.name.getText());
    }
  }
  return names.join("/") || "<module>";
}

function literalText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = ts.isNumericLiteral(span.expression)
        ? span.expression.text
        : literalText(span.expression);
      if (value === undefined) return undefined;
      text += value + span.literal.text;
    }
    return text;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = literalText(node.left);
    const right = literalText(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function propertyName(node) {
  if (ts.isComputedPropertyName(node)) return literalText(node.expression);
  return ts.isIdentifier(node) ? node.text : literalText(node);
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node))
    return literalText(node.argumentExpression);
  return undefined;
}

function constructedText(node) {
  const literal = literalText(node);
  if (literal !== undefined) return literal;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return constructedText(node.left) + constructedText(node.right);
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map(
          (span) => `${constructedText(span.expression)}${span.literal.text}`,
        )
        .join("")
    );
  }
  return "${dynamic}";
}

function hasDynamicUtility(text) {
  return text
    .split(/\s+/)
    .some(
      (token) =>
        token.includes("${dynamic}") && /(?:^|:)!?-?z-|\[z-index:/.test(token),
    );
}

function scanCss(text, scope, line, add, context = "stylesheet") {
  const ast = css.parse(text, { context, positions: true });
  const parents = [];
  css.walk(ast, {
    enter(node) {
      if (node.type === "Rule") parents.push(css.generate(node.prelude));
      if (node.type === "Atrule") {
        parents.push(
          `@${node.name}${node.prelude ? ` ${css.generate(node.prelude)}` : ""}`,
        );
        if (node.name === "apply" && node.prelude) {
          scanUtilities(
            css.generate(node.prelude),
            [scope, ...parents.slice(0, -1)].filter(Boolean).join(" > "),
            line + node.loc.start.line - 1,
            add,
          );
        }
      }
      if (
        node.type === "Declaration" &&
        node.property.toLowerCase() === "z-index"
      ) {
        add({
          scope: [scope, ...parents].filter(Boolean).join(" > "),
          kind: "css",
          value: `${css.generate(node.value)}${node.important ? "!important" : ""}`,
          line: line + node.loc.start.line - 1,
        });
      }
    },
    leave(node) {
      if (node.type === "Rule" || node.type === "Atrule") parents.pop();
    },
  });
}

function scanUtilities(text, scope, line, add) {
  for (const token of text.split(/\s+/)) {
    if (utility.test(token))
      add({ scope, kind: "utility", value: token, line });
  }
}

function scanScript(text, file, add, prefix = "", startLine = 1) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const record = (node, kind, value) => {
    add({
      scope: `${prefix}${sourceScope(node)}`,
      kind,
      value,
      line:
        startLine +
        source.getLineAndCharacterOfPosition(node.getStart(source)).line,
    });
  };
  const code = (node) =>
    printer.printNode(ts.EmitHint.Unspecified, node, source).trim();
  const zProperty = (name) => name === "zIndex" || name === "z-index";
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && zProperty(propertyName(node.name))) {
      record(node, "style", code(node.initializer));
    }
    if (ts.isShorthandPropertyAssignment(node) && zProperty(node.name.text)) {
      record(node, "style", node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      zProperty(memberName(node.left))
    ) {
      record(
        node,
        "style",
        `${node.operatorToken.getText(source)} ${code(node.right)}`,
      );
    }
    if (
      ts.isCallExpression(node) &&
      memberName(node.expression) === "setProperty" &&
      node.arguments.length >= 2 &&
      literalText(node.arguments[0])?.toLowerCase() === "z-index"
    ) {
      record(
        node,
        "style",
        `setProperty(${node.arguments.slice(1).map(code).join(", ")})`,
      );
    }

    // Count a declaration where it is written, not once per use of a constant.
    // Combine literal concatenations before scanning, and reject interpolated
    // utilities: their complete class is unavailable to both this rule and Tailwind.
    const isConcat =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken;
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateExpression(node) ||
      isConcat
    ) {
      const staticText = literalText(node);
      const scope = `${prefix}${sourceScope(node)}`;
      const line =
        startLine +
        source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      if (staticText !== undefined) {
        scanUtilities(staticText, scope, line, add);
        if (
          /<[a-z!][^>]*>/i.test(staticText) &&
          /z-index|\bz-/.test(staticText)
        ) {
          scanHtml(staticText, file, (record) =>
            add({
              ...record,
              scope: `${scope} > ${record.scope}`,
              line: line + record.line - 1,
            }),
          );
        } else if (/(?:^|[;{\n])\s*z-index\s*:/i.test(staticText)) {
          scanCss(
            staticText,
            scope,
            line,
            add,
            staticText.includes("{") ? "stylesheet" : "declarationList",
          );
        }
        return;
      }
      if (ts.isTemplateExpression(node)) {
        const pieces = [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ];
        if (hasDynamicUtility(constructedText(node))) {
          record(node, "dynamic", code(node));
        }
        if (/(?:^|[;{\n])\s*z-index\s*:/i.test(pieces.join("${dynamic}"))) {
          record(node, "dynamic", code(node));
        }
        // Static classes surrounding interpolations still need ownership.
        for (const piece of pieces) scanUtilities(piece, scope, line, add);
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
      if (
        isConcat &&
        (hasDynamicUtility(constructedText(node)) ||
          /(?:^|[;{\n])\s*z-index\s*:[^;{}]*\$\{dynamic\}/i.test(
            constructedText(node),
          ))
      ) {
        record(node, "dynamic", code(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function scanHtml(text, file, add) {
  const document = parse(text, { sourceCodeLocationInfo: true });
  const visit = (node, path = []) => {
    const attributes = new Map(
      node.attrs?.map(({ name, value }) => [name, value]),
    );
    const owner = attributes.get("id")
      ? `${node.tagName}#${attributes.get("id")}`
      : node.tagName;
    const ancestry = owner ? [...path, owner] : path;
    const scope = ancestry.join(" > ");
    const location = node.sourceCodeLocation;
    if (attributes.has("class")) {
      scanUtilities(
        attributes.get("class"),
        scope,
        location.attrs.class.startLine,
        add,
      );
    }
    if (attributes.has("style")) {
      scanCss(
        attributes.get("style"),
        scope,
        location.attrs.style.startLine,
        add,
        "declarationList",
      );
    }
    if (
      node.tagName === "style" ||
      (node.tagName === "script" && !attributes.has("src"))
    ) {
      const content = node.childNodes
        .map((child) => child.value ?? "")
        .join("");
      const line = location.startTag.endLine;
      if (node.tagName === "style") scanCss(content, scope, line, add);
      else scanScript(content, file, add, `${scope}/`, line);
      return;
    }
    for (const child of node.childNodes ?? []) visit(child, ancestry);
    if (node.content) visit(node.content, ancestry);
  };
  visit(document);
}

export function collectStackingDeclarations(root) {
  const declarations = [];
  const files = globSync(
    [
      "apps/platform/index.html",
      ...roots.map(
        (directory) =>
          `${directory}/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,css,html}`,
      ),
    ],
    { cwd: root },
  )
    .filter(isStackingSource)
    .sort();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const add = (record) => declarations.push({ file, ...record });
    if (file.endsWith(".css")) scanCss(text, "", 1, add);
    else if (file.endsWith(".html")) scanHtml(text, file, add);
    else scanScript(text, file, add);
  }
  return declarations;
}
