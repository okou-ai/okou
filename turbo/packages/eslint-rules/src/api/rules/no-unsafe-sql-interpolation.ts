import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  directTypeAnnotation,
  drizzleCallName,
  isDrizzleSqlTag,
  isDrizzleTypeReference,
  isSqlWrapperExpression,
  localFunctionReturn,
  resolveLocalExpression,
  variableInScope,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

type MessageId =
  | "anyInterpolation"
  | "arrayInterpolation"
  | "mixedInterpolation"
  | "undefinedInterpolation"
  | "unknownInterpolation";

type ValueCategory =
  "any" | "array" | "bound" | "undefined" | "unknown" | "wrapper";

const DRIZZLE_WRAPPER_TYPES = new Set(["SQL", "SQLWrapper"]);

function mergeCategories(
  members: readonly (ReadonlySet<ValueCategory> | null)[],
): ReadonlySet<ValueCategory> | null {
  if (members.some((member) => member === null)) {
    return null;
  }
  const categories = new Set<ValueCategory>();
  for (const member of members) {
    if (member !== null) {
      for (const category of member) {
        categories.add(category);
      }
    }
  }
  return categories;
}

function categoriesFromType(
  sourceCode: Parameters<typeof isDrizzleTypeReference>[0],
  node: TSESTree.TypeNode,
): ReadonlySet<ValueCategory> | null {
  switch (node.type) {
    case AST_NODE_TYPES.TSAnyKeyword:
      return new Set(["any"]);
    case AST_NODE_TYPES.TSUnknownKeyword:
      return new Set(["unknown"]);
    case AST_NODE_TYPES.TSUndefinedKeyword:
    case AST_NODE_TYPES.TSVoidKeyword:
      return new Set(["undefined"]);
    case AST_NODE_TYPES.TSArrayType:
    case AST_NODE_TYPES.TSTupleType:
      return new Set(["array"]);
    case AST_NODE_TYPES.TSBigIntKeyword:
    case AST_NODE_TYPES.TSBooleanKeyword:
    case AST_NODE_TYPES.TSLiteralType:
    case AST_NODE_TYPES.TSNeverKeyword:
    case AST_NODE_TYPES.TSNullKeyword:
    case AST_NODE_TYPES.TSNumberKeyword:
    case AST_NODE_TYPES.TSStringKeyword:
      return new Set(["bound"]);
    case AST_NODE_TYPES.TSTypeOperator:
      return node.typeAnnotation === undefined
        ? null
        : categoriesFromType(sourceCode, node.typeAnnotation);
    case AST_NODE_TYPES.TSUnionType:
    case AST_NODE_TYPES.TSIntersectionType:
      return mergeCategories(
        node.types.map((member) => {
          return categoriesFromType(sourceCode, member);
        }),
      );
    case AST_NODE_TYPES.TSTypeReference: {
      if (isDrizzleTypeReference(sourceCode, node, DRIZZLE_WRAPPER_TYPES)) {
        return new Set(["wrapper"]);
      }
      const name =
        node.typeName.type === AST_NODE_TYPES.Identifier
          ? node.typeName.name
          : node.typeName.type === AST_NODE_TYPES.TSQualifiedName
            ? node.typeName.right.name
            : null;
      return name === "Array" || name === "ReadonlyArray"
        ? new Set(["array"])
        : null;
    }
    default:
      return null;
  }
}

function localFunctionReturnType(
  sourceCode: Parameters<typeof variableInScope>[0],
  node: TSESTree.CallExpression,
): TSESTree.TypeNode | null {
  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }
  const variable = variableInScope(sourceCode, node.callee);
  const functionDefinition = variable?.defs.find((definition) => {
    return definition.type === "FunctionName";
  });
  if (
    functionDefinition?.node.type === AST_NODE_TYPES.FunctionDeclaration ||
    functionDefinition?.node.type === AST_NODE_TYPES.FunctionExpression ||
    functionDefinition?.node.type === AST_NODE_TYPES.TSDeclareFunction
  ) {
    return functionDefinition.node.returnType?.typeAnnotation ?? null;
  }
  const variableDefinition = variable?.defs.find((definition) => {
    return definition.type === "Variable";
  });
  if (
    variableDefinition?.node.type !== AST_NODE_TYPES.VariableDeclarator ||
    variableDefinition.node.init === null ||
    (variableDefinition.node.init.type !==
      AST_NODE_TYPES.ArrowFunctionExpression &&
      variableDefinition.node.init.type !== AST_NODE_TYPES.FunctionExpression)
  ) {
    return null;
  }
  return variableDefinition.node.init.returnType?.typeAnnotation ?? null;
}

function spreadTypeAnnotation(
  sourceCode: Parameters<typeof variableInScope>[0],
  node: TSESTree.Expression,
): TSESTree.TypeNode | null {
  let annotation = directTypeAnnotation(sourceCode, node);
  const resolved = resolveLocalExpression(sourceCode, node);
  if (annotation === null && resolved.type === AST_NODE_TYPES.CallExpression) {
    annotation = localFunctionReturnType(sourceCode, resolved);
  }
  while (annotation?.type === AST_NODE_TYPES.TSTypeOperator) {
    annotation = annotation.typeAnnotation ?? null;
  }
  return annotation;
}

function spreadElementCategories(
  sourceCode: Parameters<typeof variableInScope>[0],
  node: TSESTree.Expression,
): ReadonlySet<ValueCategory> | null {
  const annotation = spreadTypeAnnotation(sourceCode, node);
  if (annotation?.type === AST_NODE_TYPES.TSArrayType) {
    return categoriesFromType(sourceCode, annotation.elementType);
  }
  if (annotation?.type === AST_NODE_TYPES.TSTupleType) {
    return mergeCategories(
      annotation.elementTypes.map((element) => {
        if (element.type === AST_NODE_TYPES.TSNamedTupleMember) {
          return categoriesFromType(sourceCode, element.elementType);
        }
        if (
          element.type === AST_NODE_TYPES.TSOptionalType ||
          element.type === AST_NODE_TYPES.TSRestType
        ) {
          return categoriesFromType(sourceCode, element.typeAnnotation);
        }
        return categoriesFromType(sourceCode, element);
      }),
    );
  }
  if (
    annotation?.type === AST_NODE_TYPES.TSTypeReference &&
    annotation.typeArguments?.params.length === 1
  ) {
    const name =
      annotation.typeName.type === AST_NODE_TYPES.Identifier
        ? annotation.typeName.name
        : annotation.typeName.type === AST_NODE_TYPES.TSQualifiedName
          ? annotation.typeName.right.name
          : null;
    const elementType = annotation.typeArguments.params[0];
    if (name === "Array" || name === "ReadonlyArray") {
      return elementType === undefined
        ? null
        : categoriesFromType(sourceCode, elementType);
    }
  }
  return null;
}

function spreadIsDefinitelyPresent(
  sourceCode: Parameters<typeof variableInScope>[0],
  node: TSESTree.Expression,
): boolean {
  const annotation = spreadTypeAnnotation(sourceCode, node);
  if (
    annotation?.type !== AST_NODE_TYPES.TSTupleType ||
    annotation.elementTypes.length === 0
  ) {
    return false;
  }
  const first = annotation.elementTypes[0];
  return (
    first !== undefined &&
    first.type !== AST_NODE_TYPES.TSOptionalType &&
    first.type !== AST_NODE_TYPES.TSRestType &&
    !(first.type === AST_NODE_TYPES.TSNamedTupleMember && first.optional)
  );
}

function booleanHelperCategories(
  sourceCode: Parameters<typeof variableInScope>[0],
  node: TSESTree.CallExpression,
): ReadonlySet<ValueCategory> {
  let definitelyPresent = false;
  for (const argument of node.arguments) {
    if (argument.type === AST_NODE_TYPES.SpreadElement) {
      const spread = resolveLocalExpression(sourceCode, argument.argument);
      if (spread.type !== AST_NODE_TYPES.ArrayExpression) {
        const categories = spreadElementCategories(
          sourceCode,
          argument.argument,
        );
        if (
          categories !== null &&
          !categories.has("undefined") &&
          categories.has("wrapper") &&
          spreadIsDefinitelyPresent(sourceCode, argument.argument)
        ) {
          definitelyPresent = true;
        }
        continue;
      }
      for (const element of spread.elements) {
        if (element === null || element.type === AST_NODE_TYPES.SpreadElement) {
          continue;
        }
        const categories = categoriesFromExpression(sourceCode, element);
        if (
          categories !== null &&
          categories.has("wrapper") &&
          !categories.has("undefined")
        ) {
          definitelyPresent = true;
        }
      }
      continue;
    }
    const categories = categoriesFromExpression(sourceCode, argument);
    if (
      categories !== null &&
      categories.has("wrapper") &&
      !categories.has("undefined")
    ) {
      definitelyPresent = true;
    }
  }
  return definitelyPresent
    ? new Set(["wrapper"])
    : new Set(["undefined", "wrapper"]);
}

function categoriesFromExpression(
  sourceCode: Parameters<typeof variableInScope>[0],
  node: TSESTree.Expression,
  visitingCalls = new Set<TSESTree.CallExpression>(),
): ReadonlySet<ValueCategory> | null {
  const annotation = directTypeAnnotation(sourceCode, node);
  if (annotation !== null) {
    return categoriesFromType(sourceCode, annotation);
  }
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved !== node) {
    return categoriesFromExpression(sourceCode, resolved, visitingCalls);
  }
  if (
    resolved.type === AST_NODE_TYPES.Literal ||
    resolved.type === AST_NODE_TYPES.TemplateLiteral
  ) {
    return new Set(["bound"]);
  }
  if (
    resolved.type === AST_NODE_TYPES.Identifier &&
    resolved.name === "undefined" &&
    (variableInScope(sourceCode, resolved) === null ||
      variableInScope(sourceCode, resolved)?.defs.length === 0)
  ) {
    return new Set(["undefined"]);
  }
  if (resolved.type === AST_NODE_TYPES.ArrayExpression) {
    return new Set(["array"]);
  }
  if (resolved.type === AST_NODE_TYPES.ConditionalExpression) {
    return mergeCategories([
      categoriesFromExpression(sourceCode, resolved.consequent, visitingCalls),
      categoriesFromExpression(sourceCode, resolved.alternate, visitingCalls),
    ]);
  }
  if (resolved.type === AST_NODE_TYPES.LogicalExpression) {
    const left = categoriesFromExpression(
      sourceCode,
      resolved.left,
      visitingCalls,
    );
    const right = categoriesFromExpression(
      sourceCode,
      resolved.right,
      visitingCalls,
    );
    if (resolved.operator === "??" && left !== null) {
      const narrowedLeft = new Set(left);
      narrowedLeft.delete("undefined");
      return mergeCategories([narrowedLeft, right]);
    }
    return mergeCategories([left, right]);
  }
  if (resolved.type === AST_NODE_TYPES.CallExpression) {
    const callName = drizzleCallName(sourceCode, resolved);
    if (callName === "and" || callName === "or") {
      return booleanHelperCategories(sourceCode, resolved);
    }
    if (isSqlWrapperExpression(sourceCode, resolved)) {
      return new Set(["wrapper"]);
    }
    const returned = localFunctionReturn(sourceCode, resolved);
    if (returned !== null && !visitingCalls.has(resolved)) {
      visitingCalls.add(resolved);
      const categories = categoriesFromExpression(
        sourceCode,
        returned,
        visitingCalls,
      );
      visitingCalls.delete(resolved);
      if (categories !== null) {
        return categories;
      }
    }
    const returnType = localFunctionReturnType(sourceCode, resolved);
    return returnType === null
      ? null
      : categoriesFromType(sourceCode, returnType);
  }
  return isSqlWrapperExpression(sourceCode, resolved)
    ? new Set(["wrapper"])
    : null;
}

function interpolationProblem(
  categories: ReadonlySet<ValueCategory> | null,
): MessageId | null {
  if (categories === null) {
    return null;
  }
  if (categories.has("any")) {
    return "anyInterpolation";
  }
  if (categories.has("unknown")) {
    return "unknownInterpolation";
  }
  if (categories.has("undefined")) {
    return "undefinedInterpolation";
  }
  if (categories.has("array")) {
    return "arrayInterpolation";
  }
  return categories.has("wrapper") && categories.has("bound")
    ? "mixedInterpolation"
    : null;
}

export const noUnsafeSqlInterpolation = createRule({
  name: "no-unsafe-sql-interpolation",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require inspectable, unambiguous values in conventional Drizzle SQL interpolations",
      recommended: true,
    },
    schema: [],
    messages: {
      anyInterpolation:
        "Do not interpolate any into Drizzle SQL. Give the value an explicit safe type before constructing SQL.",
      unknownInterpolation:
        "Do not interpolate unknown into Drizzle SQL. Narrow it to a bound value or an explicit SQL wrapper first.",
      undefinedInterpolation:
        "Drizzle omits undefined interpolations. Narrow the value first, or use sql.empty() for an intentionally empty fragment.",
      arrayInterpolation:
        "Drizzle expands a directly interpolated array or tuple as SQL chunks. Use sql.param(...) for one bound value or sql.join(...) for fragments.",
      mixedInterpolation:
        "Do not mix SQL wrappers and bound values in one interpolation type. Convert the value to an explicit parameter or fragment before this boundary.",
    },
  },
  create(context) {
    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (!isDrizzleSqlTag(context.sourceCode, node.tag)) {
          return;
        }
        for (const expression of node.quasi.expressions) {
          const messageId = interpolationProblem(
            categoriesFromExpression(context.sourceCode, expression),
          );
          if (messageId !== null) {
            context.report({ node: expression, messageId });
          }
        }
      },
    };
  },
});
