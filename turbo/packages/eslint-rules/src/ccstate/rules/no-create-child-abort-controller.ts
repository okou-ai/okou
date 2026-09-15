/**
 * ESLint rule: no-create-child-abort-controller
 *
 * createChildAbortController() creates imperative cancellation ownership outside
 * the ccstate signal hierarchy. Operations should inherit an existing owner or
 * use a stable resetSignal() command for local cancellation and mutual exclusion.
 */

import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const TARGET_NAME = "createChildAbortController";

interface ImportReference {
  readonly importedName: string;
}

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

export default createRule({
  name: "no-create-child-abort-controller",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow createChildAbortController() — use the ccstate signal hierarchy",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      childAbortController:
        "Do not call createChildAbortController(). Inherit pageSignal$/rootSignal$ or use a stable resetSignal() command for operation ownership.",
    },
  },
  create(context) {
    function importReference(
      node: TSESTree.Identifier,
    ): ImportReference | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node,
      );
      const definition = variable?.defs.find((candidate) => {
        return candidate.type === "ImportBinding";
      });
      const specifier = definition?.node;
      if (
        specifier === undefined ||
        (specifier.type !== AST_NODE_TYPES.ImportNamespaceSpecifier &&
          specifier.type !== AST_NODE_TYPES.ImportSpecifier)
      ) {
        return null;
      }
      return {
        importedName:
          specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier
            ? "*"
            : specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : String(specifier.imported.value),
      };
    }

    function isTargetCall(node: TSESTree.CallExpression): boolean {
      const callee = node.callee;
      if (callee.type === AST_NODE_TYPES.Identifier) {
        const reference = importReference(callee);
        return reference
          ? reference.importedName === TARGET_NAME
          : callee.name === TARGET_NAME;
      }
      if (
        callee.type !== AST_NODE_TYPES.MemberExpression ||
        callee.object.type !== AST_NODE_TYPES.Identifier ||
        memberName(callee) !== TARGET_NAME
      ) {
        return false;
      }
      return importReference(callee.object)?.importedName === "*";
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (isTargetCall(node)) {
          context.report({ node, messageId: "childAbortController" });
        }
      },
    };
  },
});
