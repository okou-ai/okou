/**
 * ESLint rule: no-side-effect-in-render
 *
 * Prevents calling side-effect functions directly in React component render body.
 * Side effects (set(), detach(), etc.) must be inside event handler callbacks,
 * effect hooks, or other nested functions — never at the top level of render.
 *
 * Bad:
 *   function MyView() {
 *     const set = useSet();
 *     set(fetchCommand$);           // side effect during render!
 *     detach(promise, Reason.X);    // side effect during render!
 *     return <div />;
 *   }
 *
 * Good:
 *   function MyView() {
 *     const set = useSet();
 *     return <button onClick={() => {
 *       detach(set(cmd$), Reason.DomCallback);
 *     }}>Go</button>;
 *   }
 */

import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "noSetInRender" | "noSideEffectInRender";
type Options = [{ forbiddenCalls?: string[] }];

const DEFAULT_FORBIDDEN_CALLS = ["detach", "queueMicrotask"];

function isComponentOrHookFunction(
  node:
    | TSESTree.FunctionDeclaration
    | TSESTree.ArrowFunctionExpression
    | TSESTree.FunctionExpression,
): boolean {
  // PascalCase function declaration: function MyView() {}
  if (node.type === "FunctionDeclaration" && node.id) {
    return /^[A-Z]/.test(node.id.name);
  }

  // Arrow function or function expression assigned to PascalCase variable:
  // const MyView = () => {} or const MyView = function() {}
  const parent = node.parent;
  if (
    parent?.type === "VariableDeclarator" &&
    parent.id.type === "Identifier"
  ) {
    return /^[A-Z]/.test(parent.id.name);
  }

  // export default function() {} — treat as component if in a .tsx file
  if (
    node.type === "FunctionDeclaration" &&
    node.parent?.type === "ExportDefaultDeclaration"
  ) {
    const filename = getCurrentFilename(node);
    return filename.endsWith(".tsx");
  }

  return false;
}

function getCurrentFilename(node: TSESTree.Node): string {
  let current: TSESTree.Node = node;
  while (current.parent) {
    current = current.parent;
  }
  // The root node doesn't have filename, we rely on context instead
  return "";
}

export default createRule<Options, MessageIds>({
  name: "no-side-effect-in-render",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling side-effect functions directly in React component render body",
    },
    schema: [
      {
        type: "object",
        properties: {
          forbiddenCalls: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional function names to forbid in render (default: ['detach'])",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noSetInRender:
        "Do not call the useSet() setter directly during render. Move the call into an event handler or wrap with detach() inside a callback.",
      noSideEffectInRender:
        "Do not call '{{ name }}()' directly during render. Side effects should be in event handlers or effect callbacks.",
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const forbiddenCalls = new Set(
      options.forbiddenCalls ?? DEFAULT_FORBIDDEN_CALLS,
    );

    // Track function nesting: [isComponent, isComponent, ...]
    // When we enter a component function, push true. For nested functions, push false.
    // A call is "in render" when the innermost function scope is a component (stack top === true).
    const scopeStack: boolean[] = [];

    // Track variable names that hold useSet() return values, per component scope
    const setterNamesStack: Set<string>[] = [];

    function enterFunction(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionExpression,
    ): void {
      const isComponent = isComponentOrHookFunction(node);
      scopeStack.push(isComponent);
      if (isComponent) {
        setterNamesStack.push(new Set());
      }
    }

    function exitFunction(): void {
      const wasComponent = scopeStack.pop();
      if (wasComponent) {
        setterNamesStack.pop();
      }
    }

    function isInRenderScope(): boolean {
      // The call is directly in render if the innermost scope is a component scope
      return (
        scopeStack.length > 0 && scopeStack[scopeStack.length - 1] === true
      );
    }

    function getCurrentSetterNames(): Set<string> | undefined {
      return setterNamesStack.length > 0
        ? setterNamesStack[setterNamesStack.length - 1]
        : undefined;
    }

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,

      // Track: const set = useSet()
      VariableDeclarator(node: TSESTree.VariableDeclarator): void {
        if (!isInRenderScope()) {
          return;
        }

        const init = node.init;
        if (
          init?.type === "CallExpression" &&
          init.callee.type === "Identifier" &&
          init.callee.name === "useSet" &&
          node.id.type === "Identifier"
        ) {
          getCurrentSetterNames()?.add(node.id.name);
        }
      },

      // Check for forbidden calls
      CallExpression(node: TSESTree.CallExpression): void {
        if (!isInRenderScope()) {
          return;
        }

        const callee = node.callee;
        if (
          callee.type === "CallExpression" &&
          callee.callee.type === "Identifier" &&
          callee.callee.name === "useSet"
        ) {
          context.report({
            node,
            messageId: "noSetInRender",
          });
          return;
        }

        if (callee.type !== "Identifier") {
          return;
        }

        // Check for set() from useSet()
        const setterNames = getCurrentSetterNames();
        if (setterNames?.has(callee.name)) {
          context.report({
            node,
            messageId: "noSetInRender",
          });
          return;
        }

        // Check for forbidden function calls (detach, etc.)
        if (forbiddenCalls.has(callee.name)) {
          context.report({
            node,
            messageId: "noSideEffectInRender",
            data: { name: callee.name },
          });
        }
      },
    };
  },
});
