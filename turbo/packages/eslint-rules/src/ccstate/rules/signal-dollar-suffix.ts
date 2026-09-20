/**
 * ESLint rule: signal-dollar-suffix
 *
 * Enforces that variables assigned from state(), computed(), or command()
 * calls must end with a $ suffix.
 *
 * Good: const count$ = state(0)
 * Bad: const count = state(0)
 */

import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`,
);

const SIGNAL_FUNCTIONS = new Set(["state", "computed", "command"]);

type MessageIds = "missingSuffix";

export default createRule<[], MessageIds>({
  name: "signal-dollar-suffix",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce $ suffix for variables assigned from state(), computed(), or command()",
    },
    fixable: "code",
    schema: [],
    messages: {
      missingSuffix:
        "Variable '{{name}}' should end with '$' suffix because it holds a {{functionName}}() result",
    },
  },
  defaultOptions: [],
  create(context) {
    function isSignalCall(node: TSESTree.Node): {
      isSignal: boolean;
      functionName: string;
    } {
      if (node.type !== "CallExpression") {
        return { isSignal: false, functionName: "" };
      }

      const callee = node.callee;
      if (callee.type === "Identifier" && SIGNAL_FUNCTIONS.has(callee.name)) {
        return { isSignal: true, functionName: callee.name };
      }

      return { isSignal: false, functionName: "" };
    }

    function checkVariableDeclarator(node: TSESTree.VariableDeclarator): void {
      if (!node.init) {
        return;
      }

      const { isSignal, functionName } = isSignalCall(node.init);
      if (!isSignal) {
        return;
      }

      if (node.id.type !== "Identifier") {
        return;
      }

      const variableName = node.id.name;
      if (!variableName.endsWith("$")) {
        context.report({
          node: node.id,
          messageId: "missingSuffix",
          data: {
            name: variableName,
            functionName,
          },
          fix(fixer) {
            return fixer.replaceText(node.id, `${variableName}$`);
          },
        });
      }
    }

    return {
      VariableDeclarator: checkVariableDeclarator,
    };
  },
});
