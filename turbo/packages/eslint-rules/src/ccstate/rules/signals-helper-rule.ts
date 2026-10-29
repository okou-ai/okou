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

interface SignalsHelperRuleOptions<MessageId extends string> {
  readonly name: string;
  readonly helper: string;
  readonly description: string;
  readonly messageId: MessageId;
  readonly message: string;
}

/**
 * Reports runtime references to one Platform `signals/utils` helper, including
 * renamed imports, namespace access, value escapes and re-exports.
 */
export function createSignalsHelperRule<MessageId extends string>({
  name,
  helper,
  description,
  messageId,
  message,
}: SignalsHelperRuleOptions<MessageId>) {
  return createRule({
    name,
    defaultOptions: [],
    meta: {
      type: "problem",
      docs: {
        description,
        recommended: true,
        requiresTypeChecking: false,
      },
      schema: [],
      messages: { [messageId]: message } as Record<MessageId, string>,
    },
    create(context) {
      function isSignalsUtils(source: string): boolean {
        const resolved = source.startsWith(".")
          ? path.resolve(path.dirname(context.filename), source)
          : source;
        return /(?:^|\/)signals\/utils(?:\.[cm]?[jt]s)?$/u.test(resolved);
      }

      function report(node: TSESTree.Node): void {
        context.report({ node, messageId });
      }

      return {
        "ImportDeclaration:exit"(node: TSESTree.ImportDeclaration): void {
          if (
            node.importKind === "type" ||
            !isSignalsUtils(node.source.value)
          ) {
            return;
          }
          for (const variable of context.sourceCode.getDeclaredVariables(
            node,
          )) {
            const specifier = variable.defs[0]?.node;
            if (specifier?.type === AST_NODE_TYPES.ImportSpecifier) {
              if (
                specifier.importKind !== "type" &&
                propertyName(specifier.imported) === helper
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
                  propertyName(parent.property) === helper
                ) {
                  report(parent);
                } else if (
                  parent.type === AST_NODE_TYPES.MemberExpression &&
                  parent.object === reference.identifier &&
                  (!parent.computed ||
                    parent.property.type === AST_NODE_TYPES.Literal)
                ) {
                  // Selecting another helper does not expose this one.
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
                          propertyName(property.key) === helper))
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
              propertyName(specifier.local) === helper
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
}
