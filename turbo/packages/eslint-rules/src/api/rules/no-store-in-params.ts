import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

export interface NoStoreInParamsOptions {
  readonly allowedFunctions?: readonly string[];
}

export type NoStoreInParamsMessageIds =
  "noStoreInParams" | "noStoreInObjectParams";

function findStorePath(
  typeNode: TSESTree.TypeNode,
  path: readonly string[] = [],
  depth = 0,
): readonly string[] | null {
  if (depth > 3) {
    return null;
  }

  switch (typeNode.type) {
    case AST_NODE_TYPES.TSTypeReference: {
      const { typeName } = typeNode;
      if (
        typeName.type === AST_NODE_TYPES.Identifier &&
        typeName.name === "Store"
      ) {
        return path;
      }

      if (typeNode.typeArguments) {
        for (const arg of typeNode.typeArguments.params) {
          const found = findStorePath(arg, path, depth + 1);
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }

    case AST_NODE_TYPES.TSUnionType:
    case AST_NODE_TYPES.TSIntersectionType: {
      for (const memberType of typeNode.types) {
        const found = findStorePath(memberType, path, depth + 1);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }

    case AST_NODE_TYPES.TSArrayType: {
      return findStorePath(typeNode.elementType, [...path, "[]"], depth + 1);
    }

    case AST_NODE_TYPES.TSTypeLiteral: {
      for (const member of typeNode.members) {
        if (
          member.type !== AST_NODE_TYPES.TSPropertySignature ||
          !member.typeAnnotation
        ) {
          continue;
        }

        const propertyName =
          member.key.type === AST_NODE_TYPES.Identifier ? member.key.name : "?";
        const found = findStorePath(
          member.typeAnnotation.typeAnnotation,
          [...path, propertyName],
          depth + 1,
        );
        if (found !== null) {
          return found;
        }
      }
      return null;
    }

    default: {
      return null;
    }
  }
}

export const noStoreInParams = createRule<
  [NoStoreInParamsOptions?],
  NoStoreInParamsMessageIds
>({
  name: "no-store-in-params",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Prevent Store type in function parameters",
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedFunctions: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noStoreInParams:
        "Function parameters should not accept Store type: {{param}}",
      noStoreInObjectParams:
        "Function parameters should not contain Store type in object properties: {{param}}.{{property}}",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowedFunctions = new Set(options.allowedFunctions ?? []);

    function checkParameter(param: TSESTree.Parameter): void {
      if (param.type !== AST_NODE_TYPES.Identifier) {
        return;
      }

      const annotation = param.typeAnnotation?.typeAnnotation;
      if (!annotation) {
        return;
      }

      const storePath = findStorePath(annotation);
      if (storePath === null) {
        return;
      }

      if (storePath.length === 0) {
        context.report({
          node: param,
          messageId: "noStoreInParams",
          data: { param: param.name },
        });
        return;
      }

      context.report({
        node: param,
        messageId: "noStoreInObjectParams",
        data: { param: param.name, property: storePath.join(".") },
      });
    }

    function functionName(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionExpression,
    ): string | undefined {
      if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
        return node.id?.name;
      }

      if (
        node.parent?.type === AST_NODE_TYPES.VariableDeclarator &&
        node.parent.id.type === AST_NODE_TYPES.Identifier
      ) {
        return node.parent.id.name;
      }

      return undefined;
    }

    function checkFunction(
      node:
        | TSESTree.FunctionDeclaration
        | TSESTree.ArrowFunctionExpression
        | TSESTree.FunctionExpression,
    ): void {
      const name = functionName(node);
      if (name !== undefined && allowedFunctions.has(name)) {
        return;
      }

      for (const param of node.params) {
        checkParameter(param);
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      ArrowFunctionExpression: checkFunction,
      "FunctionExpression:not(MethodDefinition > FunctionExpression)":
        checkFunction,
      MethodDefinition(node: TSESTree.MethodDefinition): void {
        if (node.value.type === AST_NODE_TYPES.FunctionExpression) {
          checkFunction(node.value);
        }
      },
    };
  },
});
