import path from "node:path";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function propertyName(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }
  return node.type === AST_NODE_TYPES.Literal && typeof node.value === "string"
    ? node.value
    : null;
}

function isTypeQuery(node: TSESTree.Node): boolean {
  let parent = node.parent;
  while (parent?.type === AST_NODE_TYPES.TSQualifiedName) {
    parent = parent.parent;
  }
  return parent?.type === AST_NODE_TYPES.TSTypeQuery;
}

export default createRule({
  name: "no-on-rejection",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Require explicit review for Platform onRejection usage",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noOnRejection:
        "Do not add onRejection error callbacks. Let accept errors propagate and derive request state from the operation's loadable. Review infrastructure exceptions explicitly. See docs/app/signals/onRejection.md.",
    },
  },
  create(context) {
    function isSignalsUtils(source: string): boolean {
      const resolved = source.startsWith(".")
        ? path.resolve(path.dirname(context.filename), source)
        : source;
      return /(?:^|\/)signals\/utils(?:\.[cm]?[jt]s)?$/u.test(resolved);
    }

    function report(node: TSESTree.Node): void {
      context.report({ node, messageId: "noOnRejection" });
    }

    return {
      "ImportDeclaration:exit"(node: TSESTree.ImportDeclaration): void {
        if (node.importKind === "type" || !isSignalsUtils(node.source.value)) {
          return;
        }
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          const specifier = variable.defs[0]?.node;
          if (specifier?.type === AST_NODE_TYPES.ImportSpecifier) {
            if (
              specifier.importKind !== "type" &&
              propertyName(specifier.imported) === "onRejection"
            ) {
              for (const reference of variable.references) {
                if (
                  reference.isValueReference &&
                  reference.isRead() &&
                  !isTypeQuery(reference.identifier)
                ) {
                  report(reference.identifier);
                }
              }
            }
          } else if (
            specifier?.type === AST_NODE_TYPES.ImportNamespaceSpecifier
          ) {
            for (const reference of variable.references) {
              if (
                !reference.isValueReference ||
                !reference.isRead() ||
                isTypeQuery(reference.identifier)
              ) {
                continue;
              }
              const parent = reference.identifier.parent;
              if (
                parent.type === AST_NODE_TYPES.MemberExpression &&
                parent.object === reference.identifier &&
                (!parent.computed ||
                  parent.property.type === AST_NODE_TYPES.Literal) &&
                propertyName(parent.property) === "onRejection"
              ) {
                report(parent);
              } else if (
                parent.type === AST_NODE_TYPES.MemberExpression &&
                parent.object === reference.identifier &&
                (!parent.computed ||
                  parent.property.type === AST_NODE_TYPES.Literal)
              ) {
                // Selecting another helper does not expose onRejection.
                continue;
              } else if (
                parent.type === AST_NODE_TYPES.VariableDeclarator &&
                parent.init === reference.identifier &&
                parent.id.type === AST_NODE_TYPES.ObjectPattern
              ) {
                for (const property of parent.id.properties) {
                  if (
                    property.type === AST_NODE_TYPES.RestElement ||
                    (property.type === AST_NODE_TYPES.Property &&
                      ((property.computed &&
                        property.key.type !== AST_NODE_TYPES.Literal) ||
                        propertyName(property.key) === "onRejection"))
                  ) {
                    report(property);
                  }
                }
              } else {
                // Namespace escapes and dynamic keys can hide this helper.
                report(reference.identifier);
              }
            }
          }
        }
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration): void {
        if (
          node.exportKind === "type" ||
          !node.source ||
          !isSignalsUtils(node.source.value)
        ) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.exportKind !== "type" &&
            propertyName(specifier.local) === "onRejection"
          ) {
            report(specifier);
          }
        }
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration): void {
        if (node.exportKind !== "type" && isSignalsUtils(node.source.value)) {
          report(node);
        }
      },
    };
  },
});
