/**
 * ESLint rule: no-mockapi-raw-async
 *
 * Disallows raw async primitives inside MSW handlers in tests.
 * mockApi/http handlers should use the signal-aware helpers exposed by
 * src/mocks/msw-contract.ts:
 *   - deferred()
 *   - never()
 *   - delay(ms)
 *   - withSignal(promise)
 *
 * Bad:
 *   mockApi(route, ({ respond }) => {
 *     return new Promise((resolve) => {
 *       setTimeout(() => resolve(respond(200, {})), 1000);
 *     });
 *   })
 *
 * Good:
 *   mockApi(route, ({ respond, deferred }) => {
 *     const gate = deferred<void>();
 *     return gate.promise.then(() => respond(200, {}));
 *   })
 */

import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const MESSAGE =
  "Do not use raw Promise/timer primitives inside MSW handlers. Use signal-aware helpers from mockApi context: deferred(), never(), delay(), or withSignal().";

export default createRule({
  name: "no-mockapi-raw-async",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Promise/timer primitives inside mockApi handlers",
    },
    schema: [],
    messages: {
      noRawPromise: MESSAGE,
      noRawTimer: MESSAGE,
      noExternalPromise: MESSAGE,
    },
  },
  create(context) {
    const handlerStack: (
      TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression
    )[] = [];

    function isMswHandler(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ): boolean {
      const parent = node.parent;
      if (parent?.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (
        parent.callee.type === AST_NODE_TYPES.Identifier &&
        parent.callee.name === "mockApi" &&
        parent.arguments[1] === node
      ) {
        return true;
      }
      return (
        parent.callee.type === AST_NODE_TYPES.MemberExpression &&
        parent.callee.object.type === AST_NODE_TYPES.Identifier &&
        parent.callee.object.name === "http" &&
        parent.callee.property.type === AST_NODE_TYPES.Identifier &&
        ["get", "post", "put", "patch", "delete"].includes(
          parent.callee.property.name,
        ) &&
        parent.arguments[1] === node
      );
    }

    function currentHandler() {
      return handlerStack[handlerStack.length - 1];
    }

    function inHandler(): boolean {
      return handlerStack.length > 0;
    }

    function isRawPromiseVariable(
      node: TSESTree.Identifier,
      handler: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ): boolean {
      let currentScope: TSESLint.Scope.Scope | null =
        context.sourceCode.getScope(node);
      while (currentScope) {
        const variable = currentScope.variables.find((entry) => {
          return entry.name === node.name;
        });
        const def = variable?.defs[0];
        if (def && def.node.type === AST_NODE_TYPES.VariableDeclarator) {
          const declaration = def.node;
          if (
            declaration.init &&
            declaration.init.type === AST_NODE_TYPES.NewExpression &&
            declaration.init.callee.type === AST_NODE_TYPES.Identifier &&
            declaration.init.callee.name === "Promise"
          ) {
            return !(
              declaration.range[0] >= handler.range[0] &&
              declaration.range[1] <= handler.range[1]
            );
          }
        }
        currentScope = currentScope.upper;
      }
      return false;
    }

    return {
      ArrowFunctionExpression(node: TSESTree.ArrowFunctionExpression) {
        if (isMswHandler(node)) {
          handlerStack.push(node);
        }
      },
      "ArrowFunctionExpression:exit"(node: TSESTree.ArrowFunctionExpression) {
        if (currentHandler() === node) {
          handlerStack.pop();
        }
      },
      FunctionExpression(node: TSESTree.FunctionExpression) {
        if (isMswHandler(node)) {
          handlerStack.push(node);
        }
      },
      "FunctionExpression:exit"(node: TSESTree.FunctionExpression) {
        if (currentHandler() === node) {
          handlerStack.pop();
        }
      },
      NewExpression(node: TSESTree.NewExpression) {
        if (
          inHandler() &&
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "Promise"
        ) {
          context.report({ node, messageId: "noRawPromise" });
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (!inHandler() || node.callee.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        if (
          node.callee.name === "setTimeout" ||
          node.callee.name === "setInterval"
        ) {
          context.report({ node, messageId: "noRawTimer" });
        }
      },
      AwaitExpression(node: TSESTree.AwaitExpression) {
        const handler = currentHandler();
        if (!handler || node.argument.type !== AST_NODE_TYPES.Identifier) {
          return;
        }
        if (isRawPromiseVariable(node.argument, handler)) {
          context.report({
            node: node.argument,
            messageId: "noExternalPromise",
          });
        }
      },
    };
  },
});
