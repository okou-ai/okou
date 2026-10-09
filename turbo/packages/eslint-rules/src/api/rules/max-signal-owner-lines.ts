import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";
import { createComputedFactoryVerifier } from "../signal-factory-verification.ts";

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

/**
 * Count operational callbacks separately from their declarative graph owner.
 * This replaces max-lines-per-function only for the two chat-pick graph files.
 * Merely naming a function an owner never exempts imperative setup or helpers.
 */
export const maxSignalOwnerLines = createRule({
  name: "max-signal-owner-lines",
  defaultOptions: [{ max: 128, owners: [] as string[] }],
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Bound operational functions while allowing verified declarative signal owners",
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          max: { type: "integer", minimum: 1 },
          owners: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      tooLong:
        "Function has {{lines}} non-comment lines (maximum {{max}}). Only a verified declarative signal owner is counted by its individual callbacks.",
    },
  },
  create(context, [options]) {
    const verifyComputedFactory = createComputedFactoryVerifier();

    function isComputedFactory(node: TSESTree.CallExpression): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.Identifier ||
        !node.arguments.every((argument) => {
          return (
            argument.type === AST_NODE_TYPES.Identifier ||
            argument.type === AST_NODE_TYPES.Literal
          );
        })
      ) {
        return false;
      }
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node.callee,
      );
      const definition = variable?.defs.find(
        (item) => item.type === "ImportBinding",
      );
      if (
        definition?.node.type !== AST_NODE_TYPES.ImportSpecifier ||
        definition.node.importKind === "type" ||
        definition.node.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
        definition.node.parent.importKind === "type"
      ) {
        return false;
      }
      const imported = definition.node.imported;
      return verifyComputedFactory(
        context.filename,
        definition.node.parent.source.value,
        imported.type === AST_NODE_TYPES.Identifier
          ? imported.name
          : imported.value,
      );
    }

    function isSignalConstructor(node: TSESTree.CallExpression): boolean {
      if (node.callee.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node.callee,
      );
      const definition = variable?.defs.find((definition) => {
        const specifier = definition.node;
        return (
          definition.type === "ImportBinding" &&
          specifier.type === AST_NODE_TYPES.ImportSpecifier &&
          specifier.parent.source?.value === "ccstate" &&
          specifier.imported.type === AST_NODE_TYPES.Identifier &&
          ["state", "computed", "command"].includes(specifier.imported.name)
        );
      });
      if (
        !definition ||
        definition.node.type !== AST_NODE_TYPES.ImportSpecifier
      ) {
        return false;
      }
      const imported = definition.node.imported;
      if (
        imported.type !== AST_NODE_TYPES.Identifier ||
        node.arguments.length !== 1
      ) {
        return false;
      }
      const [argument] = node.arguments;
      return (
        argument !== undefined &&
        (imported.name === "state"
          ? isDeclarationValue(argument)
          : argument.type === AST_NODE_TYPES.ArrowFunctionExpression ||
            argument.type === AST_NODE_TYPES.FunctionExpression)
      );
    }

    function isDeclarationValue(node: TSESTree.Node): boolean {
      switch (node.type) {
        case AST_NODE_TYPES.Identifier:
        case AST_NODE_TYPES.Literal:
          return true;
        case AST_NODE_TYPES.TSAsExpression:
        case AST_NODE_TYPES.TSSatisfiesExpression:
        case AST_NODE_TYPES.TSNonNullExpression:
          return isDeclarationValue(node.expression);
        case AST_NODE_TYPES.MemberExpression:
          return (
            isDeclarationValue(node.object) &&
            (!node.computed || isDeclarationValue(node.property))
          );
        case AST_NODE_TYPES.ObjectExpression:
          return node.properties.every((property) => {
            return property.type === AST_NODE_TYPES.Property
              ? !property.method && isDeclarationValue(property.value)
              : isDeclarationValue(property.argument);
          });
        case AST_NODE_TYPES.ArrayExpression:
          return node.elements.every((element) => {
            return element === null || isDeclarationValue(element);
          });
        case AST_NODE_TYPES.CallExpression:
          return isSignalConstructor(node) || isComputedFactory(node);
        default:
          return false;
      }
    }

    function isDeclarativeOwner(node: FunctionNode): boolean {
      if (
        node.type !== AST_NODE_TYPES.FunctionDeclaration ||
        !node.id ||
        !options.owners.includes(node.id.name) ||
        node.async ||
        node.generator ||
        !node.body ||
        (node.parent.type !== AST_NODE_TYPES.Program &&
          node.parent.type !== AST_NODE_TYPES.ExportNamedDeclaration)
      ) {
        return false;
      }
      const statements = node.body.body;
      const returned = statements.at(-1);
      return (
        returned?.type === AST_NODE_TYPES.ReturnStatement &&
        returned.argument?.type === AST_NODE_TYPES.ObjectExpression &&
        isDeclarationValue(returned.argument) &&
        statements.slice(0, -1).every((statement) => {
          return (
            statement.type === AST_NODE_TYPES.VariableDeclaration &&
            statement.kind === "const" &&
            statement.declarations.every((declaration) => {
              return (
                declaration.init !== null &&
                isDeclarationValue(declaration.init)
              );
            })
          );
        })
      );
    }

    function checkFunction(node: FunctionNode): void {
      if (isDeclarativeOwner(node)) {
        return;
      }
      const lines = new Set<number>();
      for (const token of context.sourceCode.getTokens(node)) {
        for (
          let line = token.loc.start.line;
          line <= token.loc.end.line;
          line++
        ) {
          lines.add(line);
        }
      }
      if (lines.size > options.max) {
        context.report({
          node,
          messageId: "tooLong",
          data: { lines: lines.size, max: options.max },
        });
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
});
