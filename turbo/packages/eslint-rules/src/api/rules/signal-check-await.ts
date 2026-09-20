/**
 * ESLint rule: signal-check-await
 *
 * Enforces that commands check AbortSignal after await expressions
 * to properly handle cancellation.
 *
 * Good:
 *   command(async ({ signal }) => {
 *     const data = await fetch(url);
 *     signal.throwIfAborted();
 *     // process data
 *   })
 *
 * Bad:
 *   command(async ({ signal }) => {
 *     const data = await fetch(url);
 *     // missing signal check after await
 *     processData(data);
 *   })
 */

import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => {
  return `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`;
});

type MessageIds = "missingSignalCheck";

export const signalCheckAwait = createRule<[], MessageIds>({
  name: "signal-check-await",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce AbortSignal check after await expressions in commands",
    },
    schema: [],
    messages: {
      missingSignalCheck:
        "Consider checking signal.throwIfAborted() after await to handle cancellation",
    },
  },
  defaultOptions: [],
  create(context) {
    let signalParamName: string | null = null;
    let inCommand = false;
    let functionDepth = 0;
    let commandCallback: TSESTree.Node | null = null;

    function isCommandCall(node: TSESTree.CallExpression): boolean {
      const callee = node.callee;
      return callee.type === "Identifier" && callee.name === "command";
    }

    function getSignalParamName(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ): string | null {
      // Iterate all parameters, not just the first one
      for (const param of node.params) {
        // Case 1: standalone parameter signal: AbortSignal
        if (param.type === "Identifier" && param.name === "signal") {
          return "signal";
        }

        // Case 2: destructured parameter { signal } or { signal: customName }
        if (param.type !== "ObjectPattern") {
          continue;
        }

        for (const prop of param.properties) {
          if (prop.type !== "Property") {
            continue;
          }
          if (prop.key.type !== "Identifier" || prop.key.name !== "signal") {
            continue;
          }

          // Found the signal property
          if (prop.value.type === "Identifier") {
            return prop.value.name;
          }
          return "signal";
        }
      }

      return null;
    }

    function isSignalCheck(node: TSESTree.Node): boolean {
      if (!signalParamName) {
        return false;
      }

      if (node.type === "ExpressionStatement") {
        const expr = node.expression;
        if (expr.type === "CallExpression") {
          const callee = expr.callee;
          if (
            callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            callee.object.name === signalParamName &&
            callee.property.type === "Identifier" &&
            callee.property.name === "throwIfAborted"
          ) {
            return true;
          }
        }
      }

      if (node.type === "IfStatement") {
        const test = node.test;
        if (
          test.type === "MemberExpression" &&
          test.object.type === "Identifier" &&
          test.object.name === signalParamName &&
          test.property.type === "Identifier" &&
          test.property.name === "aborted"
        ) {
          return true;
        }
      }

      return false;
    }

    function objectContainsSignal(node: TSESTree.ObjectExpression): boolean {
      return node.properties.some((prop) => {
        if (prop.type !== "Property") {
          return false;
        }
        // { signal } or { signal: signal }
        if (prop.key.type === "Identifier" && prop.key.name === "signal") {
          if (prop.value.type === "Identifier") {
            return prop.value.name === signalParamName;
          }
          return prop.key.name === signalParamName;
        }
        // Nested object: { fetchOptions: { signal } }
        if (prop.value.type === "ObjectExpression") {
          return objectContainsSignal(prop.value);
        }
        return false;
      });
    }

    function hasSignalInArguments(
      awaitExpr: TSESTree.AwaitExpression,
    ): boolean {
      if (!signalParamName) {
        return false;
      }

      const arg = awaitExpr.argument;
      if (arg.type !== "CallExpression") {
        return false;
      }

      // Check all arguments of the call expression
      return arg.arguments.some((argNode) => {
        // Case 1: Direct pass - someFunc(signal)
        if (argNode.type === "Identifier" && argNode.name === signalParamName) {
          return true;
        }

        // Case 2: In object literal (recursive) - someFunc({ signal }) or someFunc({ opts: { signal } })
        if (argNode.type === "ObjectExpression") {
          return objectContainsSignal(argNode);
        }

        return false;
      });
    }

    function checkAwaitInBlock(statements: TSESTree.Statement[]): void {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        if (!stmt) {
          continue;
        }

        let awaitExpr: TSESTree.AwaitExpression | null = null;

        // Extract await expression from statement
        if (stmt.type === "ExpressionStatement") {
          if (stmt.expression.type === "AwaitExpression") {
            awaitExpr = stmt.expression;
          }
        } else if (stmt.type === "VariableDeclaration") {
          // Find the first await expression in declarations
          for (const decl of stmt.declarations) {
            if (decl.init?.type === "AwaitExpression") {
              awaitExpr = decl.init;
              break;
            }
          }
        }

        if (awaitExpr) {
          // If signal is already passed to the awaited function, no check needed
          if (hasSignalInArguments(awaitExpr)) {
            continue;
          }

          // Otherwise, require signal check after await
          const nextStmt = statements[i + 1];
          if (nextStmt && !isSignalCheck(nextStmt)) {
            context.report({
              node: stmt,
              messageId: "missingSignalCheck",
            });
          }
        }
      }
    }

    return {
      CallExpression(node) {
        if (isCommandCall(node) && node.arguments[0]) {
          const callback = node.arguments[0];
          if (
            callback.type === "ArrowFunctionExpression" ||
            callback.type === "FunctionExpression"
          ) {
            if (callback.async) {
              inCommand = true;
              signalParamName = getSignalParamName(callback);
              functionDepth = 0;
              commandCallback = callback; // Save reference to command callback
            }
          }
        }
      },
      "CallExpression:exit"(node: TSESTree.CallExpression) {
        if (isCommandCall(node)) {
          inCommand = false;
          signalParamName = null;
          functionDepth = 0;
          commandCallback = null;
        }
      },
      ArrowFunctionExpression(node) {
        // Track nested async functions inside command (but not the command callback itself)
        if (
          inCommand &&
          signalParamName &&
          node.async &&
          node !== commandCallback
        ) {
          functionDepth++;
        }
      },
      "ArrowFunctionExpression:exit"(node: TSESTree.ArrowFunctionExpression) {
        if (
          inCommand &&
          signalParamName &&
          node.async &&
          node !== commandCallback &&
          functionDepth > 0
        ) {
          functionDepth--;
        }
      },
      FunctionExpression(node) {
        // Track nested async functions inside command (but not the command callback itself)
        if (
          inCommand &&
          signalParamName &&
          node.async &&
          node !== commandCallback
        ) {
          functionDepth++;
        }
      },
      "FunctionExpression:exit"(node: TSESTree.FunctionExpression) {
        if (
          inCommand &&
          signalParamName &&
          node.async &&
          node !== commandCallback &&
          functionDepth > 0
        ) {
          functionDepth--;
        }
      },
      BlockStatement(node) {
        // Only check await in the command's direct block, not nested functions
        if (inCommand && signalParamName && functionDepth === 0) {
          checkAwaitInBlock(node.body);
        }
      },
    };
  },
});
