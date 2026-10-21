/**
 * ESLint rule: test-context-in-hooks
 *
 * Prevents destructuring testContext() return value outside test hooks.
 * This ensures proper test isolation and cleanup.
 *
 * Good:
 *   const context = testContext();
 *   it('should work', () => {
 *     const { store, signal } = context;
 *   });
 *
 * Bad:
 *   const { store, signal } = testContext(); // Destructuring at top level
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

interface Options {
  readonly allowRegistration?: boolean;
}

export default createRule<
  [Options],
  "testContextDestructuringOutsideHook" | "testContextRegistrationInHelper"
>({
  name: "test-context-in-hooks",
  defaultOptions: [{ allowRegistration: true }],
  meta: {
    type: "problem",
    docs: {
      description: "Prevent destructuring testContext() outside test hooks",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: { allowRegistration: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
    messages: {
      testContextRegistrationInHelper:
        "Test helpers must receive an explicit context; register testContext() in the owning test file.",
      testContextDestructuringOutsideHook:
        "Destructuring testContext() return value must happen within test hooks",
    },
  },
  create(context, [options]) {
    const allowRegistration = options.allowRegistration !== false;
    const contextNames = new Set(["testContext"]);
    const contextNamespaces = new Set<string>();
    const testHooks = new Set([
      "it",
      "test",
      "beforeEach",
      "afterEach",
      "beforeAll",
      "afterAll",
    ]);
    let currentTestHookDepth = 0;

    function isInTestHook(): boolean {
      return currentTestHookDepth > 0;
    }

    function isTestContextCall(node: TSESTree.CallExpression): boolean {
      if (node.callee.type === AST_NODE_TYPES.Identifier) {
        return contextNames.has(node.callee.name);
      }
      return (
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        node.callee.object.type === AST_NODE_TYPES.Identifier &&
        contextNamespaces.has(node.callee.object.name) &&
        ((!node.callee.computed &&
          node.callee.property.type === AST_NODE_TYPES.Identifier &&
          node.callee.property.name === "testContext") ||
          (node.callee.computed &&
            node.callee.property.type === AST_NODE_TYPES.Literal &&
            node.callee.property.value === "testContext"))
      );
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
            contextNamespaces.add(specifier.local.name);
          } else if (
            specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            ((specifier.imported.type === AST_NODE_TYPES.Identifier &&
              specifier.imported.name === "testContext") ||
              (specifier.imported.type === AST_NODE_TYPES.Literal &&
                specifier.imported.value === "testContext"))
          ) {
            contextNames.add(specifier.local.name);
          }
        }
      },
      // Track when we enter/exit test hooks
      CallExpression(node: TSESTree.CallExpression) {
        if (!allowRegistration && isTestContextCall(node)) {
          context.report({
            node,
            messageId: "testContextRegistrationInHelper",
          });
        }
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          testHooks.has(node.callee.name)
        ) {
          currentTestHookDepth++;
        }
      },

      "CallExpression:exit"(node: TSESTree.CallExpression) {
        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          testHooks.has(node.callee.name)
        ) {
          currentTestHookDepth--;
        }
      },

      // Only check for destructuring assignment from testContext()
      VariableDeclarator(node: TSESTree.VariableDeclarator) {
        if (
          allowRegistration &&
          node.init &&
          node.init.type === AST_NODE_TYPES.CallExpression &&
          isTestContextCall(node.init) &&
          !isInTestHook() &&
          node.id.type === AST_NODE_TYPES.ObjectPattern
        ) {
          context.report({
            node,
            messageId: "testContextDestructuringOutsideHook",
          });
        }
      },
    };
  },
});
