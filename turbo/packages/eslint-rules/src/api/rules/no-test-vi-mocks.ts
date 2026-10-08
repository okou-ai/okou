import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export const noTestViMocks = createRule({
  name: "no-test-vi-mocks",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Test files must use centralized external service mocks from testContext",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noTestViMock:
        "Mock external modules only in src/__tests__/mocks.ts, and change return values through stubs exposed by testContext().",
    },
  },
  create(context) {
    const viAliases = new Set(["vi"]);
    const bannedMethods = new Set([
      "doMock",
      "doUnmock",
      "fn",
      "hoisted",
      "mock",
      "mocked",
      "resetAllMocks",
      "restoreAllMocks",
      "spyOn",
      "stubEnv",
      "stubGlobal",
      "unmock",
      "unstubAllGlobals",
    ]);

    function trackViImport(node: TSESTree.ImportDeclaration): void {
      if (node.source.value !== "vitest") {
        return;
      }

      for (const specifier of node.specifiers) {
        if (
          specifier.type === AST_NODE_TYPES.ImportSpecifier &&
          specifier.imported.type === AST_NODE_TYPES.Identifier &&
          specifier.imported.name === "vi"
        ) {
          viAliases.add(specifier.local.name);
        }
      }
    }

    function checkCall(node: TSESTree.CallExpression): void {
      const callee = node.callee;
      if (
        callee.type !== AST_NODE_TYPES.MemberExpression ||
        callee.object.type !== AST_NODE_TYPES.Identifier ||
        callee.property.type !== AST_NODE_TYPES.Identifier ||
        !viAliases.has(callee.object.name) ||
        !bannedMethods.has(callee.property.name)
      ) {
        return;
      }

      // The sole generalized harness replaces only the database transport;
      // it still executes real migrations, SQL and production route behavior.
      const target = node.arguments[0];
      if (
        context.filename
          .replaceAll("\\", "/")
          .endsWith("/src/__tests__/pglite-setup.ts") &&
        callee.property.name === "mock" &&
        target?.type === AST_NODE_TYPES.Literal &&
        target.value === "../lib/db"
      ) {
        return;
      }
      context.report({
        node,
        messageId: "noTestViMock",
      });
    }

    return {
      ImportDeclaration: trackViImport,
      CallExpression: checkCall,
    };
  },
});
