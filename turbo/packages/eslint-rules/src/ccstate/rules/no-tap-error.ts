import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function propertyName(node: TSESTree.Property | TSESTree.MemberExpression) {
  const key = node.type === AST_NODE_TYPES.Property ? node.key : node.property;
  if (!node.computed && key.type === AST_NODE_TYPES.Identifier) {
    return key.name;
  }
  return key.type === AST_NODE_TYPES.Literal ? key.value : undefined;
}

export default createRule({
  name: "no-tap-error",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow tapError references that turn failures into undefined",
      recommended: true,
      url: "https://github.com/okou-ai/okou/blob/main/docs/app/signals/tapError.md",
    },
    schema: [],
    messages: {
      noTapError:
        "Do not use tapError to swallow failures. Propagate errors and derive UI from loadables. See docs/app/signals/tapError.md.",
    },
  },
  create(context) {
    return {
      "ImportDeclaration:exit"(node: TSESTree.ImportDeclaration) {
        if (node.importKind === "type") {
          return;
        }
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          const specifier = variable.defs[0]?.node;
          if (specifier?.type === AST_NODE_TYPES.ImportSpecifier) {
            const imported = specifier.imported;
            const name =
              imported.type === AST_NODE_TYPES.Identifier
                ? imported.name
                : imported.value;
            if (name !== "tapError" || specifier.importKind === "type") {
              continue;
            }
            for (const reference of variable.references) {
              if (reference.isValueReference) {
                context.report({
                  node: reference.identifier,
                  messageId: "noTapError",
                });
              }
            }
          } else if (
            specifier?.type === AST_NODE_TYPES.ImportNamespaceSpecifier
          ) {
            for (const reference of variable.references) {
              const identifier = reference.identifier;
              const parent = identifier.parent;
              if (
                parent.type === AST_NODE_TYPES.MemberExpression &&
                parent.object === identifier &&
                propertyName(parent) === "tapError"
              ) {
                context.report({ node: parent, messageId: "noTapError" });
              } else if (
                parent.type === AST_NODE_TYPES.VariableDeclarator &&
                parent.init === identifier &&
                parent.id.type === AST_NODE_TYPES.ObjectPattern
              ) {
                for (const property of parent.id.properties) {
                  if (
                    property.type === AST_NODE_TYPES.Property &&
                    propertyName(property) === "tapError"
                  ) {
                    context.report({ node: property, messageId: "noTapError" });
                  }
                }
              }
            }
          }
        }
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        if (!node.source || node.exportKind === "type") {
          return;
        }
        for (const specifier of node.specifiers) {
          const local = specifier.local;
          const name =
            local.type === AST_NODE_TYPES.Identifier ? local.name : local.value;
          if (name === "tapError" && specifier.exportKind !== "type") {
            context.report({ node: specifier, messageId: "noTapError" });
          }
        }
      },
    };
  },
});
