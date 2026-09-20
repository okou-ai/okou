/**
 * Shared utilities for custom ESLint rules.
 */

import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

interface RuleDocs {
  description: string;
  recommended?: boolean;
  requiresTypeChecking?: boolean;
}

export const createRule = ESLintUtils.RuleCreator<RuleDocs>(
  (name) => `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`,
);

export interface TypeRefPath {
  name: string;
  path: string[];
}

// Returns the path where one of the named type references was found, or null
// if not found. path=[] means the type is direct; path=["store"] means a
// property like { store: Store } matched.
//
// This checks type annotation text only, not symbol origin. Qualified names
// such as lib.Store are intentionally ignored.
export function findTypeRefPath(
  typeNode: TSESTree.TypeNode,
  names: ReadonlySet<string>,
  path: string[] = [],
  depth = 0,
): TypeRefPath | null {
  if (depth > 6) {
    return null;
  }

  switch (typeNode.type) {
    case AST_NODE_TYPES.TSTypeReference: {
      const { typeName } = typeNode;
      if (
        typeName.type === AST_NODE_TYPES.Identifier &&
        names.has(typeName.name)
      ) {
        return { name: typeName.name, path };
      }
      if (typeNode.typeArguments) {
        for (const arg of typeNode.typeArguments.params) {
          const found = findTypeRefPath(arg, names, path, depth + 1);
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }

    case AST_NODE_TYPES.TSUnionType:
    case AST_NODE_TYPES.TSIntersectionType: {
      for (const t of typeNode.types) {
        const found = findTypeRefPath(t, names, path, depth + 1);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }

    case AST_NODE_TYPES.TSArrayType: {
      return findTypeRefPath(typeNode.elementType, names, path, depth + 1);
    }

    case AST_NODE_TYPES.TSTypeLiteral: {
      for (const member of typeNode.members) {
        if (
          member.type === AST_NODE_TYPES.TSPropertySignature &&
          member.typeAnnotation
        ) {
          const propName =
            member.key.type === AST_NODE_TYPES.Identifier
              ? member.key.name
              : "?";
          const found = findTypeRefPath(
            member.typeAnnotation.typeAnnotation,
            names,
            [...path, propName],
            depth + 1,
          );
          if (found !== null) {
            return found;
          }
        }
      }
      return null;
    }

    default: {
      return null;
    }
  }
}
