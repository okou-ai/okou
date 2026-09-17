import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const __dirname = path.dirname(scriptPath);
const defaultAppRoot = path.resolve(__dirname, "..");

function getCheckedFiles(appRoot) {
  const excludedDirectories = new Set(["__tests__", "i18n", "mocks", "test"]);
  const checkedFiles = [];

  function collectFiles(relativeDirectory) {
    for (const entry of readdirSync(path.join(appRoot, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          collectFiles(relativePath);
        }
        continue;
      }
      if (
        (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) &&
        !relativePath.endsWith(".test.ts") &&
        !relativePath.endsWith(".test.tsx")
      ) {
        checkedFiles.push(relativePath);
      }
    }
  }

  collectFiles("src");
  return checkedFiles.sort();
}

function isUserVisibleAttribute(value) {
  return [
    "alt",
    "aria-description",
    "aria-label",
    "aria-placeholder",
    "description",
    "label",
    "placeholder",
    "title",
  ].includes(value);
}

function isUserVisibleProperty(value) {
  return [
    "actionLabel",
    "ariaLabel",
    "buttonLabel",
    "caption",
    "content",
    "description",
    "emptyLabel",
    "emptyMessage",
    "errorMessage",
    "heading",
    "help",
    "helperText",
    "hint",
    "label",
    "message",
    "name",
    "placeholder",
    "result",
    "subtitle",
    "summary",
    "title",
    "tooltip",
    "tooltipLabel",
  ].includes(value);
}

function isToastMethod(value) {
  return ["error", "info", "success", "warning"].includes(value);
}

function isUserVisibleFunctionName(value) {
  return (
    /(caption|copy|description|displayName|displayText|heading|help|hint|label|message|plainText|summary|title|tooltip)$/iu.test(
      value,
    ) ||
    /^format.*(?:Codex|Plan)/u.test(value) ||
    [
      "formatMessageHtml",
      "normalizeCodexRunEvent",
      "stringifyArrayJsonValue",
      "stringifyObjectJsonValue",
    ].includes(value)
  );
}

// These literals are intentionally shown as protocol identifiers, provider or
// product names, or example input values. Keep exclusions exact and explain why
// each value must remain untranslated.
function getInternalAllowedLiterals() {
  return [
    [
      "src/signals/okou-page/chat-feedback.ts\u0000a sent email (mail ID: {…}{…})",
      "locale-neutral serialized agent prompt metadata",
    ],
    [
      "src/signals/okou-page/chat-feedback.ts\u0000an email draft (mail draft ID: {…})",
      "locale-neutral serialized agent prompt metadata",
    ],
    [
      "src/signals/activity-page/log-detail-utils.ts\u0000null",
      "JSON null literal in user-visible diagnostic serialization",
    ],
    [
      "src/signals/chat-page/chat-event-state.ts\u0000Run cancelled",
      "internal run event payload; the rendered cancellation message uses typed i18n",
    ],
    [
      "src/shared-database/protocol.ts\u0000Run-output subscriptions require a run UUID",
      "SharedWorker protocol validation error, not user-visible UI copy",
    ],
    [
      "src/signals/shared-database-browser.ts\u0000okou_{…}_{…}{…}",
      "SharedWorker browser identifier, not user-visible UI copy",
    ],
    [
      "src/signals/okou-page/tiptap-workflow-composer.ts\u0000paragraph+",
      "Tiptap document schema expression",
    ],
    [
      "src/signals/okou-page/tiptap-workflow-composer.ts\u0000workflowHighlight",
      "Tiptap extension identifier",
    ],
    [
      "src/views/okou-page/tiptap-instructions-editor.tsx\u0000baselineMarkdown",
      "Tiptap storage plugin identifier",
    ],
  ];
}

function getConnectorAllowedLiterals() {
  return [
    [
      "src/views/okou-page/components/model-provider-picker.tsx\u0000BYOK",
      "bring-your-own-key product acronym",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000Acme API",
      "example connector name",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000Authorization",
      "example HTTP header name",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000Bearer {{secret}}",
      "example HTTP authorization value",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000{{secret}}",
      "header-template interpolation token",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000API credential",
      "locale-neutral persisted field metadata",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000PKCE",
      "OAuth protocol extension name",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000S256",
      "OAuth PKCE method identifier",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000Secret",
      "locale-neutral persisted field metadata",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000consent",
      "example OAuth prompt value",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000https://api.acme.com/v1/",
      "example API URL",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000https://api.provider.example",
      "example OAuth audience",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000https://provider.example.com/oauth/authorize",
      "example OAuth authorization URL",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000https://provider.example.com/oauth/token",
      "example OAuth token URL",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000offline",
      "example OAuth access type",
    ],
    [
      "src/views/okou-page/components/settings/custom-connector-create-dialog.tsx\u0000read\nwrite",
      "example OAuth scopes",
    ],
    [
      "src/views/okou-page/feishu-card.tsx\u0000cli_...",
      "example Feishu application identifier",
    ],
    [
      "src/views/okou-page/feishu-card.tsx\u0000im.message.receive_v1",
      "Feishu event identifier",
    ],
  ];
}

function getFileAllowedLiterals() {
  return [
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000DB",
      "database file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000DOC",
      "document file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000HTML",
      "HTML file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000JSON",
      "JSON file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000MD",
      "Markdown file extension",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000PDF",
      "PDF file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000PPT",
      "presentation file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000TXT",
      "plain-text file extension",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000XLS",
      "spreadsheet file format abbreviation",
    ],
    [
      "src/views/okou-page/file-preview-icon.tsx\u0000ZIP",
      "archive file format abbreviation",
    ],
  ];
}

function getLocaleIndependentShellAllowedLiterals() {
  return [
    [
      "src/views/okou-page/app-skeleton.tsx\u0000Loading",
      "locale-independent accessibility label for the copy-free app skeleton",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000Use a supported browser to continue",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000Update Chrome to continue",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000Update Chromium to continue",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000Update iOS to continue",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000Update Safari to continue",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000does not support your current browser version. Update your browser to continue.",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
    [
      "src/views/unsupported-browser-page.tsx\u0000does not support this browser on your device. Update your browser, or try another browser or device.",
      "English-only browser compatibility shell outside localized app bootstrap",
    ],
  ];
}

function getAllowedLiterals() {
  return new Map([
    ...getInternalAllowedLiterals(),
    ...getConnectorAllowedLiterals(),
    ...getFileAllowedLiterals(),
    ...getLocaleIndependentShellAllowedLiterals(),
  ]);
}

function getLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => {
        return ["{…}", span.literal.text];
      }),
    ].join("");
  }
  return null;
}

function getPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  return null;
}

function hasHumanText(value) {
  const withoutEntities = value.replace(
    /&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/giu,
    "",
  );
  return /\p{L}/u.test(withoutEntities);
}

function bindingNames(node) {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return node.elements.flatMap((element) => {
      return ts.isBindingElement(element) ? bindingNames(element.name) : [];
    });
  }
  return [];
}

function variableBindingScope(node) {
  if (ts.isCatchClause(node.parent)) {
    return node.parent;
  }
  let parent = node.parent;
  while (parent) {
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}

function declarationBindingScope(node) {
  let parent = node.parent;
  while (parent) {
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}

function addBinding(scopeBindings, scope, name, kind) {
  if (!scope) {
    return;
  }
  let bindings = scopeBindings.get(scope);
  if (!bindings) {
    bindings = new Map();
    scopeBindings.set(scope, bindings);
  }
  const existing = bindings.get(name);
  bindings.set(name, existing && existing !== kind ? "other" : kind);
}

function resolveBindingKind(node, name, scopeBindings) {
  let parent = node;
  while (parent) {
    const kind = scopeBindings.get(parent)?.get(name);
    if (kind) {
      return kind;
    }
    parent = parent.parent;
  }
  return null;
}

function getTranslationBindings(sourceFile) {
  const scopeBindings = new Map();
  const translationCandidates = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }
    if (importClause.name) {
      addBinding(scopeBindings, sourceFile, importClause.name.text, "other");
    }
    const namedBindings = importClause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      addBinding(scopeBindings, sourceFile, namedBindings.name.text, "other");
      continue;
    }
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }
    for (const element of namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const kind =
        moduleName === "react-i18next" && imported === "useTranslation"
          ? "useTranslation"
          : /(?:^|\/)i18n\/index(?:\.ts)?$/u.test(moduleName) &&
              imported === "i18n"
            ? "i18n"
            : "other";
      addBinding(scopeBindings, sourceFile, element.name.text, kind);
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const scope = variableBindingScope(node);
      const isTranslationCandidate =
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression);
      for (const name of bindingNames(node.name)) {
        const element = ts.isObjectBindingPattern(node.name)
          ? node.name.elements.find((candidate) => {
              return (
                ts.isIdentifier(candidate.name) && candidate.name.text === name
              );
            })
          : undefined;
        const imported = element?.propertyName?.getText(sourceFile) ?? name;
        if (isTranslationCandidate && imported === "t") {
          translationCandidates.push({
            hookCall: node.initializer,
            localName: name,
            scope,
          });
        } else {
          addBinding(scopeBindings, scope, name, "other");
        }
      }
    } else if (ts.isParameter(node)) {
      const scope = ts.isFunctionLike(node.parent) ? node.parent : null;
      for (const name of bindingNames(node.name)) {
        addBinding(scopeBindings, scope, name, "other");
      }
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      addBinding(
        scopeBindings,
        declarationBindingScope(node),
        node.name.text,
        "other",
      );
    } else if (ts.isFunctionExpression(node) && node.name) {
      addBinding(scopeBindings, node, node.name.text, "other");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const candidate of translationCandidates) {
    const hookName = candidate.hookCall.expression.text;
    const kind =
      resolveBindingKind(candidate.hookCall, hookName, scopeBindings) ===
      "useTranslation"
        ? "translation"
        : "other";
    addBinding(scopeBindings, candidate.scope, candidate.localName, kind);
  }
  return scopeBindings;
}

function isTranslationCall(node, translationBindings) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  if (ts.isIdentifier(node.expression)) {
    return (
      resolveBindingKind(node, node.expression.text, translationBindings) ===
      "translation"
    );
  }
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "t" &&
    ts.isIdentifier(node.expression.expression) &&
    resolveBindingKind(
      node,
      node.expression.expression.text,
      translationBindings,
    ) === "i18n"
  );
}

function isPotentialTranslationCall(node) {
  return (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === "t") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "t"))
  );
}

function checkVisibleExpression(node, record, kind, translationBindings) {
  if (isTranslationCall(node, translationBindings)) {
    return;
  }
  const value = getLiteralValue(node);
  if (value !== null) {
    record(node, value, kind);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    checkVisibleExpression(node.whenTrue, record, kind, translationBindings);
    checkVisibleExpression(node.whenFalse, record, kind, translationBindings);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    if (
      node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      checkVisibleExpression(node.left, record, kind, translationBindings);
      checkVisibleExpression(node.right, record, kind, translationBindings);
      return;
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      checkVisibleExpression(node.right, record, kind, translationBindings);
    }
    return;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    checkVisibleExpression(node.expression, record, kind, translationBindings);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      checkVisibleExpression(element, record, kind, translationBindings);
    }
    return;
  }
  if (isPotentialTranslationCall(node)) {
    for (const argument of node.arguments) {
      checkVisibleExpression(argument, record, kind, translationBindings);
    }
  }
}

function checkVisibleCallChain(node, record, kind, translationBindings) {
  if (isTranslationCall(node, translationBindings)) {
    return;
  }
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression)) {
      checkVisibleCallChain(
        node.expression.expression,
        record,
        kind,
        translationBindings,
      );
    }
    for (const argument of node.arguments) {
      checkVisibleCallChain(argument, record, kind, translationBindings);
    }
    return;
  }
  checkVisibleExpression(node, record, kind, translationBindings);
}

function checkVisibleStructure(node, record, kind, translationBindings) {
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        checkVisibleStructure(
          property.initializer,
          record,
          kind,
          translationBindings,
        );
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      checkVisibleStructure(element, record, kind, translationBindings);
    }
    return;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    checkVisibleStructure(node.expression, record, kind, translationBindings);
    return;
  }
  checkVisibleExpression(node, record, kind, translationBindings);
}

function checkHtmlExpression(node, record, kind, translationBindings) {
  if (isTranslationCall(node, translationBindings)) {
    return;
  }
  const value = getLiteralValue(node);
  if (value !== null) {
    const visibleText = value
      .replace(/<[^>]*>/gu, " ")
      .replaceAll("{…}", " ")
      .trim();
    record(node, visibleText, kind);
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        checkHtmlExpression(span.expression, record, kind, translationBindings);
      }
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    checkHtmlExpression(node.whenTrue, record, kind, translationBindings);
    checkHtmlExpression(node.whenFalse, record, kind, translationBindings);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    checkHtmlExpression(node.left, record, kind, translationBindings);
    checkHtmlExpression(node.right, record, kind, translationBindings);
    return;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    checkHtmlExpression(node.expression, record, kind, translationBindings);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      checkHtmlExpression(element, record, kind, translationBindings);
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression)) {
      checkHtmlExpression(
        node.expression.expression,
        record,
        kind,
        translationBindings,
      );
    }
    for (const argument of node.arguments) {
      checkHtmlExpression(argument, record, kind, translationBindings);
    }
  }
}

function isStyleElement(node) {
  if (!ts.isJsxElement(node)) {
    return false;
  }
  const tagName = node.openingElement.tagName;
  return ts.isIdentifier(tagName) && tagName.text === "style";
}

function checkJsxText(node, record) {
  if (ts.isJsxText(node) && !isStyleElement(node.parent)) {
    record(node, node.text, "JSX text");
  }
}

function checkJsxAttribute(node, record, translationBindings) {
  if (!ts.isJsxAttribute(node)) {
    return;
  }
  const attributeName = node.name.text;
  if (
    typeof attributeName !== "string" ||
    !isUserVisibleAttribute(attributeName) ||
    !node.initializer
  ) {
    return;
  }
  if (ts.isStringLiteral(node.initializer)) {
    record(node.initializer, node.initializer.text, attributeName);
    return;
  }
  if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    checkVisibleExpression(
      node.initializer.expression,
      record,
      attributeName,
      translationBindings,
    );
  }
}

function checkJsxExpression(node, record, translationBindings) {
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
    !isStyleElement(node.parent)
  ) {
    checkVisibleExpression(
      node.expression,
      record,
      "JSX expression",
      translationBindings,
    );
  }
}

function checkPropertyAssignment(node, record, translationBindings) {
  if (!ts.isPropertyAssignment(node)) {
    return;
  }
  const propertyName = getPropertyName(node.name);
  if (!propertyName || !isUserVisibleProperty(propertyName)) {
    return;
  }
  checkVisibleExpression(
    node.initializer,
    record,
    propertyName,
    translationBindings,
  );
}

function checkDocumentTitle(node, record, translationBindings) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length < 2 ||
    !ts.isIdentifier(node.arguments[0]) ||
    node.arguments[0].text !== "updateDocumentTitle$"
  ) {
    return;
  }
  checkVisibleExpression(
    node.arguments[1],
    record,
    "document title",
    translationBindings,
  );
}

function checkToastCall(node, record, translationBindings) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length === 0 ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "toast" ||
    !isToastMethod(node.expression.name.text)
  ) {
    return;
  }
  checkVisibleExpression(
    node.arguments[0],
    record,
    "toast",
    translationBindings,
  );
}

function checkBrowserDialogCall(node, record, translationBindings) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) {
    return;
  }
  const expression = node.expression;
  const methodName = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : null;
  if (!methodName || !["alert", "confirm", "prompt"].includes(methodName)) {
    return;
  }
  checkVisibleExpression(
    node.arguments[0],
    record,
    `browser ${methodName}`,
    translationBindings,
  );
}

function functionLikeName(node) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
    ) {
      return parent.name.text;
    }
  }
  return null;
}

function enclosingUserVisibleFunctionName(node) {
  let parent = node.parent;
  while (parent && !ts.isSourceFile(parent)) {
    if (ts.isFunctionLike(parent)) {
      const name = functionLikeName(parent);
      return name && isUserVisibleFunctionName(name) ? name : null;
    }
    parent = parent.parent;
  }
  return null;
}

function checkUserVisibleFunctionReturn(node, record, translationBindings) {
  if (!ts.isReturnStatement(node) || !node.expression) {
    return;
  }
  const name = enclosingUserVisibleFunctionName(node);
  if (name) {
    const checkExpression =
      name === "formatMessageHtml"
        ? checkHtmlExpression
        : /(?:Codex|Plan|plainText)/iu.test(name)
          ? checkVisibleCallChain
          : checkVisibleExpression;
    checkExpression(
      node.expression,
      record,
      `${name} return`,
      translationBindings,
    );
  }
}

function checkUserVisibleFunctionMutation(node, record, translationBindings) {
  const name = enclosingUserVisibleFunctionName(node);
  if (!name) {
    return;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
  ) {
    checkVisibleExpression(
      node.right,
      record,
      `${name} output`,
      translationBindings,
    );
    return;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["push", "unshift"].includes(node.expression.name.text)
  ) {
    const checkExpression = [
      "stringifyArrayJsonValue",
      "stringifyObjectJsonValue",
    ].includes(name)
      ? checkVisibleCallChain
      : checkVisibleExpression;
    for (const argument of node.arguments) {
      checkExpression(argument, record, `${name} output`, translationBindings);
    }
    return;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "makeCodexAssistantTextEvent"
  ) {
    for (const argument of node.arguments.slice(1)) {
      checkVisibleCallChain(
        argument,
        record,
        `${name} output`,
        translationBindings,
      );
    }
  }
}

function checkUserVisibleFunctionInitializer(
  node,
  record,
  translationBindings,
) {
  if (!ts.isVariableDeclaration(node) || !node.initializer) {
    return;
  }
  const name = enclosingUserVisibleFunctionName(node);
  if (name === "formatMessageHtml") {
    checkHtmlExpression(
      node.initializer,
      record,
      `${name} output`,
      translationBindings,
    );
  }
}

function checkUserVisibleNamedInitializer(node, record, translationBindings) {
  if (
    !ts.isVariableDeclaration(node) ||
    !ts.isIdentifier(node.name) ||
    !node.name.text.endsWith("_DISPLAY_NAMES") ||
    !node.initializer
  ) {
    return;
  }
  checkVisibleStructure(
    node.initializer,
    record,
    `${node.name.text} initializer`,
    translationBindings,
  );
}

function checkSetAttributeCall(node, record, translationBindings) {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length < 2 ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "setAttribute"
  ) {
    return;
  }
  const attribute = getLiteralValue(node.arguments[0]);
  if (!attribute || !isUserVisibleAttribute(attribute)) {
    return;
  }
  checkVisibleExpression(
    node.arguments[1],
    record,
    `setAttribute(${attribute})`,
    translationBindings,
  );
}

function checkUserVisibleAssignment(node, record, translationBindings) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(node.left)
  ) {
    return;
  }
  const propertyName = node.left.name.text;
  if (
    !["alt", "ariaLabel", "innerText", "placeholder", "title"].includes(
      propertyName,
    )
  ) {
    return;
  }
  checkVisibleExpression(
    node.right,
    record,
    `${propertyName} assignment`,
    translationBindings,
  );
}

export function checkSource(
  relativePath,
  sourceText,
  allowedLiterals = new Map(),
  usedAllowedLiterals = new Set(),
) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const translationBindings = getTranslationBindings(sourceFile);
  const violations = [];

  function record(node, value, kind) {
    const normalizedValue = value.trim();
    if (!hasHumanText(normalizedValue)) {
      return;
    }
    const exclusionKey = `${relativePath}\u0000${normalizedValue}`;
    if (allowedLiterals.has(exclusionKey)) {
      usedAllowedLiterals.add(exclusionKey);
      return;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push({
      column: position.character + 1,
      kind,
      line: position.line + 1,
      value: normalizedValue,
    });
  }

  function visit(node) {
    checkJsxText(node, record);
    checkJsxAttribute(node, record, translationBindings);
    checkJsxExpression(node, record, translationBindings);
    checkPropertyAssignment(node, record, translationBindings);
    checkDocumentTitle(node, record, translationBindings);
    checkToastCall(node, record, translationBindings);
    checkBrowserDialogCall(node, record, translationBindings);
    checkUserVisibleFunctionReturn(node, record, translationBindings);
    checkUserVisibleFunctionMutation(node, record, translationBindings);
    checkUserVisibleFunctionInitializer(node, record, translationBindings);
    checkUserVisibleNamedInitializer(node, record, translationBindings);
    checkSetAttributeCall(node, record, translationBindings);
    checkUserVisibleAssignment(node, record, translationBindings);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function checkFile(
  appRoot,
  relativePath,
  allowedLiterals,
  usedAllowedLiterals,
) {
  const absolutePath = path.join(appRoot, relativePath);
  const sourceText = readFileSync(absolutePath, "utf8");
  return checkSource(
    relativePath,
    sourceText,
    allowedLiterals,
    usedAllowedLiterals,
  );
}

function main() {
  const appRoot = defaultAppRoot;
  const allowedLiterals = getAllowedLiterals();
  const usedAllowedLiterals = new Set();
  const checkedFiles = getCheckedFiles(appRoot);
  const violations = checkedFiles.flatMap((relativePath) => {
    return checkFile(
      appRoot,
      relativePath,
      allowedLiterals,
      usedAllowedLiterals,
    ).map((violation) => {
      return { relativePath, ...violation };
    });
  });
  const unusedAllowedLiterals = Array.from(allowedLiterals.entries()).filter(
    ([key]) => {
      return !usedAllowedLiterals.has(key);
    },
  );

  if (violations.length > 0 || unusedAllowedLiterals.length > 0) {
    process.stderr.write(`Platform localized UI lint failed.

Move these user-visible literals into the typed i18n resources. If a literal is
an intentional protocol identifier, provider/product name, or example value,
add a narrow file-and-value exclusion with a reason.

${
  violations.length > 0
    ? `Hardcoded UI copy:\n${violations
        .map((violation) => {
          return `  - ${violation.relativePath}:${violation.line}:${violation.column} (${violation.kind}) ${JSON.stringify(violation.value)}`;
        })
        .join("\n")}\n`
    : ""
}
${
  unusedAllowedLiterals.length > 0
    ? `Unused exclusions (remove stale entries):\n${unusedAllowedLiterals
        .map(([key, reason]) => {
          const [relativePath, value] = key.split("\u0000");
          return `  - ${relativePath} ${JSON.stringify(value)} (${reason})`;
        })
        .join("\n")}\n`
    : ""
}
`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}
