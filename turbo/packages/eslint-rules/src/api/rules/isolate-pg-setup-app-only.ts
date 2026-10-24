import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

import { importReference, memberName, variableInScope } from "../syntax.ts";
import { createRule } from "../utils.ts";

const infrastructureFiles = [
  "/src/__tests__/test-helpers.ts",
  "/src/test-fixtures/case-database.ts",
];
const vitestFunctions = new Set([
  "it",
  "test",
  "describe",
  "suite",
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
  "onTestFinished",
  "onTestFailed",
]);
const testModifiers = new Set([
  "concurrent",
  "sequential",
  "only",
  "skip",
  "todo",
  "fails",
  "each",
  "for",
  "skipIf",
  "runIf",
]);
const testBuilders = new Set(["each", "for", "skipIf", "runIf"]);

function vitestFunction(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, node);
    if (imported?.source === "vitest") {
      return vitestFunctions.has(imported.importedName)
        ? imported.importedName
        : null;
    }
    const variable = variableInScope(sourceCode, node);
    if (variable !== null && variable.defs.length > 0) {
      return null;
    }
    return vitestFunctions.has(node.name) ? node.name : null;
  }
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    const name = memberName(node);
    if (node.object.type === AST_NODE_TYPES.Identifier) {
      const imported = importReference(sourceCode, node.object);
      if (imported?.source === "vitest" && imported.importedName === "*") {
        return name !== null && vitestFunctions.has(name) ? name : null;
      }
    }
    return name !== null && testModifiers.has(name)
      ? vitestFunction(sourceCode, node.object)
      : null;
  }
  const builder =
    node.type === AST_NODE_TYPES.CallExpression
      ? node.callee
      : node.type === AST_NODE_TYPES.TaggedTemplateExpression
        ? node.tag
        : null;
  if (builder?.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }
  const name = memberName(builder);
  return name !== null && testBuilders.has(name)
    ? vitestFunction(sourceCode, builder.object)
    : null;
}

function belongsToCase(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Node,
): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === AST_NODE_TYPES.FunctionDeclaration) {
      return false;
    }
    if (
      current.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
      current.type !== AST_NODE_TYPES.FunctionExpression
    ) {
      continue;
    }
    const call = current.parent;
    if (
      call.type !== AST_NODE_TYPES.CallExpression ||
      !call.arguments.includes(current)
    ) {
      return false;
    }
    const owner = vitestFunction(sourceCode, call.callee);
    if (owner !== null) {
      return (
        (owner === "it" || owner === "test") &&
        call.arguments.indexOf(current) > 0
      );
    }
    // Inline lifetime callbacks remain authored by this individual case.
    // A declared helper or a hook above them terminates the search.
  }
  return false;
}

function isIsolationProperty(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Node,
): boolean {
  const property = node.parent;
  if (
    property?.type !== AST_NODE_TYPES.Property ||
    property.key !== node ||
    (property.computed && node.type === AST_NODE_TYPES.Identifier) ||
    property.kind !== "init" ||
    property.method ||
    property.shorthand ||
    property.value.type !== AST_NODE_TYPES.Literal ||
    property.value.value !== true ||
    property.parent.type !== AST_NODE_TYPES.ObjectExpression
  ) {
    return false;
  }
  const options = property.parent;
  const call = options.parent;
  return (
    call.type === AST_NODE_TYPES.CallExpression &&
    call.callee.type === AST_NODE_TYPES.Identifier &&
    call.callee.name === "setupApp" &&
    call.arguments.length === 1 &&
    call.arguments[0] === options &&
    belongsToCase(sourceCode, call)
  );
}

function isPropertyOrTypeName(node: TSESTree.Node): boolean {
  const parent = node.parent;
  switch (parent?.type) {
    case AST_NODE_TYPES.Property:
    case AST_NODE_TYPES.AccessorProperty:
    case AST_NODE_TYPES.PropertyDefinition:
    case AST_NODE_TYPES.MethodDefinition:
    case AST_NODE_TYPES.TSAbstractAccessorProperty:
    case AST_NODE_TYPES.TSAbstractPropertyDefinition:
    case AST_NODE_TYPES.TSAbstractMethodDefinition:
    case AST_NODE_TYPES.TSPropertySignature:
    case AST_NODE_TYPES.TSMethodSignature:
      return parent.key === node;
    case AST_NODE_TYPES.MemberExpression:
      return parent.property === node;
    case AST_NODE_TYPES.TSEnumMember:
      return parent.id === node;
    case AST_NODE_TYPES.TSLiteralType:
      return true;
    default:
      return false;
  }
}

export const isolatePgSetupAppOnly = createRule({
  name: "isolate-pg-setup-app-only",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Select API database isolation explicitly through setupApp in each test case",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      setupAppOnly:
        "Select isolation only with setupApp({ ..., isolatePg: true }) in the individual test case. Helpers and hooks must not know isolatePg. See docs/api/api-testing.md#case-owned-database-selection.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (infrastructureFiles.some((path) => filename.endsWith(path))) {
      return {};
    }
    const reported = new Set<number>();
    function check(node: TSESTree.Node) {
      if (
        !isIsolationProperty(context.sourceCode, node) &&
        !reported.has(node.range[0])
      ) {
        reported.add(node.range[0]);
        context.report({ node, messageId: "setupAppOnly" });
      }
    }
    return {
      Identifier(node) {
        if (node.name === "isolatePg") {
          check(node);
        }
      },
      PrivateIdentifier(node) {
        if (node.name === "isolatePg") {
          check(node);
        }
      },
      JSXIdentifier(node) {
        if (node.name === "isolatePg") {
          check(node);
        }
      },
      Literal(node) {
        if (node.value === "isolatePg" && isPropertyOrTypeName(node)) {
          check(node);
        }
      },
      TemplateLiteral(node) {
        if (
          node.expressions.length === 0 &&
          node.quasis[0]?.value.cooked === "isolatePg" &&
          isPropertyOrTypeName(node)
        ) {
          check(node);
        }
      },
      TSTemplateLiteralType(node) {
        if (
          node.types.length === 0 &&
          node.quasis[0]?.value.cooked === "isolatePg"
        ) {
          check(node);
        }
      },
    };
  },
});
