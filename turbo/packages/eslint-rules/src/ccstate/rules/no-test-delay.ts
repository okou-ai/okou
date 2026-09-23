/** Disallow tests that depend on a real delay, fake timer, or elapsed wall time. */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

type DelayKind = "delay" | "fakeTimer" | "elapsedTime";

interface AllowedTestDelay {
  /** Exact path relative to the linted package (no globs). */
  file: string;
  kinds: DelayKind[];
  /** Why this exception is necessary and how it will be removed. */
  reason: string;
}

type Options = [{ allowed?: AllowedTestDelay[] }];
type MessageIds =
  | "noDelayImport"
  | "noSetTimeout"
  | "noSetInterval"
  | "noFakeTimer"
  | "noElapsedTime";

const DELAY_MESSAGE =
  "Do not sleep in tests. Control async work with an owned deferred gate or wait for an observable result.";

const FAKE_TIMER_METHODS = new Set([
  "useFakeTimers",
  "advanceTimersByTime",
  "advanceTimersByTimeAsync",
  "advanceTimersToNextTimer",
  "advanceTimersToNextTimerAsync",
  "setSystemTime",
  "runAllTimers",
  "runAllTimersAsync",
  "runOnlyPendingTimers",
  "runOnlyPendingTimersAsync",
]);

function memberName(node: TSESTree.MemberExpression): string | undefined {
  if (node.property.type === AST_NODE_TYPES.Identifier && !node.computed) {
    return node.property.name;
  }
  if (
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return undefined;
}

function isWallClockNow(node: TSESTree.Expression): boolean {
  return (
    node.type === AST_NODE_TYPES.CallExpression &&
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.object.type === AST_NODE_TYPES.Identifier &&
    (node.callee.object.name === "Date" ||
      node.callee.object.name === "performance") &&
    memberName(node.callee) === "now"
  );
}

function isWallClockDelta(node: TSESTree.Expression): boolean {
  return (
    node.type === AST_NODE_TYPES.BinaryExpression &&
    node.operator === "-" &&
    (isWallClockNow(node.left) || isWallClockNow(node.right))
  );
}

export default createRule<Options, MessageIds>({
  name: "no-test-delay",
  defaultOptions: [{}],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow real delays, fake timers, and wall-clock assertions in tests",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allowed: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file", "kinds", "reason"],
              properties: {
                file: { type: "string", minLength: 1 },
                kinds: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    enum: ["delay", "fakeTimer", "elapsedTime"],
                  },
                },
                reason: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    ],
    messages: {
      noDelayImport: DELAY_MESSAGE,
      noSetTimeout: DELAY_MESSAGE,
      noSetInterval: DELAY_MESSAGE,
      noFakeTimer:
        "Do not use fake timers in tests. Use the scoped application clock or synchronize on observable behavior.",
      noElapsedTime:
        "Do not assert elapsed wall-clock time. Assert the observable outcome or use the scoped application clock.",
    },
  },
  create(context, [options]) {
    const file = context.filename.replaceAll("\\", "/");
    const allowedKinds = new Set<DelayKind>();
    for (const entry of options.allowed ?? []) {
      if (file.endsWith(`/${entry.file}`)) {
        for (const kind of entry.kinds) {
          allowedKinds.add(kind);
        }
      }
    }

    function isElapsedAssertion(
      argument: TSESTree.CallExpressionArgument,
    ): boolean {
      if (argument.type === AST_NODE_TYPES.SpreadElement) {
        return false;
      }
      if (isWallClockDelta(argument)) {
        return true;
      }
      if (argument.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      let scope: ReturnType<typeof context.sourceCode.getScope> | null =
        context.sourceCode.getScope(argument);
      while (scope) {
        const variable = scope.set.get(argument.name);
        if (variable) {
          return variable.defs.some((definition) => {
            return (
              definition.node.type === AST_NODE_TYPES.VariableDeclarator &&
              definition.node.parent.kind === "const" &&
              definition.node.init !== null &&
              isWallClockDelta(definition.node.init)
            );
          });
        }
        scope = scope.upper;
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        if (allowedKinds.has("delay")) {
          return;
        }
        const source = node.source.value;
        const delayImports = source === "signal-timers" || source === "msw";
        const timerImports =
          source === "node:timers/promises" ||
          source === "node:timers" ||
          source === "timers/promises" ||
          source === "timers";
        if (!delayImports && !timerImports) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
            continue;
          }
          const imported =
            specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : specifier.imported.value;
          if (
            (delayImports && imported === "delay") ||
            (timerImports &&
              (imported === "setTimeout" || imported === "setInterval"))
          ) {
            context.report({ node: specifier, messageId: "noDelayImport" });
          }
        }
      },
      CallExpression(node) {
        if (node.callee.type === AST_NODE_TYPES.Identifier) {
          if (!allowedKinds.has("delay") && node.callee.name === "setTimeout") {
            context.report({ node, messageId: "noSetTimeout" });
          }
          if (
            !allowedKinds.has("delay") &&
            node.callee.name === "setInterval"
          ) {
            context.report({ node, messageId: "noSetInterval" });
          }
          if (
            !allowedKinds.has("elapsedTime") &&
            node.callee.name === "expect" &&
            node.arguments[0] &&
            isElapsedAssertion(node.arguments[0])
          ) {
            context.report({ node, messageId: "noElapsedTime" });
          }
          return;
        }
        if (
          !allowedKinds.has("fakeTimer") &&
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          node.callee.object.name === "vi" &&
          FAKE_TIMER_METHODS.has(memberName(node.callee) ?? "")
        ) {
          context.report({ node, messageId: "noFakeTimer" });
        }
        if (
          !allowedKinds.has("delay") &&
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          node.callee.object.type === AST_NODE_TYPES.Identifier &&
          (node.callee.object.name === "window" ||
            node.callee.object.name === "globalThis")
        ) {
          const method = memberName(node.callee);
          if (method === "setTimeout" || method === "setInterval") {
            context.report({
              node,
              messageId:
                method === "setTimeout" ? "noSetTimeout" : "noSetInterval",
            });
          }
        }
      },
    };
  },
});
