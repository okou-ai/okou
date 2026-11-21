import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  isColumnExpression,
  isDatabaseExpression,
  isDrizzleSqlTag,
  isDrizzleTypeReference,
  isSchemaTableExpression,
  localFunctionReturn,
  memberName,
  propertyName,
  resolveLocalExpression,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

const RESULT_FIELD_ARGUMENT = new Map<string, number>([
  ["returning", 0],
  ["select", 0],
  ["selectDistinct", 0],
  ["selectDistinctOn", 1],
]);
const RELATIONAL_RESULT_METHODS = new Set(["findFirst", "findMany"]);
const RESULT_METHODS = new Set([
  ...RESULT_FIELD_ARGUMENT.keys(),
  ...RELATIONAL_RESULT_METHODS,
]);
const BUILDER_ROOT_METHODS = new Set([
  "delete",
  "insert",
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "update",
]);
const BUILDER_CHAIN_METHODS = new Set([
  "$dynamic",
  "as",
  "crossJoin",
  "crossJoinLateral",
  "except",
  "exceptAll",
  "for",
  "from",
  "fullJoin",
  "groupBy",
  "having",
  "innerJoin",
  "innerJoinLateral",
  "intersect",
  "intersectAll",
  "leftJoin",
  "leftJoinLateral",
  "limit",
  "offset",
  "onConflictDoNothing",
  "onConflictDoUpdate",
  "orderBy",
  "rightJoin",
  "rightJoinLateral",
  "set",
  "union",
  "unionAll",
  "values",
  "where",
]);
const DRIZZLE_SQL_TYPES = new Set(["Aliased", "SQL"]);
const REVIEWED_DECODER_FACTORIES = new Set([
  "nullableDriverValueDecoder",
  "zodDriverValueDecoder",
  "zodEnumDriverValueDecoder",
]);
const REVIEWED_DECODERS = new Set([
  "pgBooleanDecoder",
  "pgInt8ToBigIntDecoder",
  "pgInt8ToSafeIntegerDecoder",
  "pgIntegerDecoder",
  "pgNullDecoder",
  "pgTextDecoder",
]);

type MessageId =
  | "resultMethodReference"
  | "sqlAliasTypeArgument"
  | "sqlAssertion"
  | "sqlTypeArgument"
  | "sqlTypeReference"
  | "uninspectableRelationalConfig"
  | "uninspectableResultArguments"
  | "uninspectableResultDecoder"
  | "uninspectableResultSelection"
  | "unmappedResult";

interface SelectionFinding {
  readonly messageId: "uninspectableResultSelection" | "unmappedResult";
  readonly node: TSESTree.Node;
}

function isDbStructuredResultSource(source: string): boolean {
  return (
    source.startsWith(".") &&
    /(?:^|\/)lib\/db-structured-result(?:\.[cm]?[jt]s)?$/.test(source)
  );
}

function builderRootedAtDatabase(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.Expression,
  visited = new Set<TSESTree.Expression>(),
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (visited.has(resolved)) {
    return false;
  }
  visited.add(resolved);
  if (
    resolved.type !== AST_NODE_TYPES.CallExpression ||
    resolved.callee.type !== AST_NODE_TYPES.MemberExpression
  ) {
    return false;
  }
  const name = memberName(resolved.callee);
  if (name !== null && BUILDER_ROOT_METHODS.has(name)) {
    return isDatabaseExpression(sourceCode, resolved.callee.object);
  }
  return (
    name !== null &&
    BUILDER_CHAIN_METHODS.has(name) &&
    builderRootedAtDatabase(sourceCode, resolved.callee.object, visited)
  );
}

function relationalQueryRootedAtDatabase(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.Expression,
): boolean {
  const tableMember = resolveLocalExpression(sourceCode, node);
  if (tableMember.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }
  const queryMember = resolveLocalExpression(sourceCode, tableMember.object);
  return (
    queryMember.type === AST_NODE_TYPES.MemberExpression &&
    memberName(queryMember) === "query" &&
    isDatabaseExpression(sourceCode, queryMember.object)
  );
}

function isResultMethodMember(
  sourceCode: Parameters<typeof isDatabaseExpression>[0],
  node: TSESTree.MemberExpression,
): boolean {
  const name = memberName(node);
  if (name === null || !RESULT_METHODS.has(name)) {
    return false;
  }
  if (
    name === "select" ||
    name === "selectDistinct" ||
    name === "selectDistinctOn"
  ) {
    return isDatabaseExpression(sourceCode, node.object);
  }
  if (name === "returning") {
    return builderRootedAtDatabase(sourceCode, node.object);
  }
  return relationalQueryRootedAtDatabase(sourceCode, node.object);
}

function isRawSqlExpression(
  sourceCode: Parameters<typeof isDrizzleSqlTag>[0],
  node: TSESTree.Expression,
  visited = new Set<TSESTree.Expression>(),
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (visited.has(resolved)) {
    return false;
  }
  visited.add(resolved);
  if (resolved.type === AST_NODE_TYPES.TaggedTemplateExpression) {
    return isDrizzleSqlTag(sourceCode, resolved.tag);
  }
  if (
    resolved.type === AST_NODE_TYPES.CallExpression &&
    resolved.callee.type === AST_NODE_TYPES.MemberExpression
  ) {
    const name = memberName(resolved.callee);
    if (name === "mapWith") {
      return false;
    }
    if (name === "as") {
      return isRawSqlExpression(sourceCode, resolved.callee.object, visited);
    }
  }
  if (resolved.type === AST_NODE_TYPES.ConditionalExpression) {
    return (
      isRawSqlExpression(sourceCode, resolved.consequent, visited) ||
      isRawSqlExpression(sourceCode, resolved.alternate, visited)
    );
  }
  if (resolved.type === AST_NODE_TYPES.LogicalExpression) {
    return (
      isRawSqlExpression(sourceCode, resolved.left, visited) ||
      isRawSqlExpression(sourceCode, resolved.right, visited)
    );
  }
  if (resolved.type === AST_NODE_TYPES.CallExpression) {
    const returned = localFunctionReturn(sourceCode, resolved);
    return (
      returned !== null && isRawSqlExpression(sourceCode, returned, visited)
    );
  }
  return false;
}

function reviewedDecoderImport(
  sourceCode: Parameters<typeof importReference>[0],
  node: TSESTree.Expression,
): string | null {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, resolved);
    return imported !== null &&
      !imported.isTypeOnly &&
      isDbStructuredResultSource(imported.source)
      ? imported.importedName
      : null;
  }
  if (resolved.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }
  const object = resolveLocalExpression(sourceCode, resolved.object);
  if (object.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }
  const imported = importReference(sourceCode, object);
  return imported?.importedName === "*" &&
    isDbStructuredResultSource(imported.source)
    ? memberName(resolved)
    : null;
}

function hasReviewedDecoder(
  sourceCode: Parameters<typeof importReference>[0],
  node: TSESTree.Expression,
  visited = new Set<TSESTree.Expression>(),
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (visited.has(resolved)) {
    return false;
  }
  visited.add(resolved);
  if (isColumnExpression(sourceCode, resolved)) {
    return true;
  }
  const importedName = reviewedDecoderImport(sourceCode, resolved);
  if (importedName !== null && REVIEWED_DECODERS.has(importedName)) {
    return true;
  }
  if (resolved.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }
  const factoryName = reviewedDecoderImport(sourceCode, resolved.callee);
  if (factoryName === null || !REVIEWED_DECODER_FACTORIES.has(factoryName)) {
    return false;
  }
  const argument = resolved.arguments[0];
  if (
    resolved.arguments.length !== 1 ||
    argument === undefined ||
    argument.type === AST_NODE_TYPES.SpreadElement
  ) {
    return false;
  }
  if (
    factoryName === "zodDriverValueDecoder" ||
    factoryName === "zodEnumDriverValueDecoder"
  ) {
    return true;
  }
  return hasReviewedDecoder(sourceCode, argument, visited);
}

function selectionFindings(
  sourceCode: Parameters<typeof isDrizzleSqlTag>[0],
  node: TSESTree.Node,
  allowUninspectable: boolean,
  visited: Set<TSESTree.Node>,
): readonly SelectionFinding[] {
  if (visited.has(node)) {
    return [];
  }
  visited.add(node);

  if (
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    return selectionFindings(
      sourceCode,
      node.expression,
      allowUninspectable,
      visited,
    );
  }
  if (node.type === AST_NODE_TYPES.Identifier) {
    if (isSchemaTableExpression(sourceCode, node)) {
      return [];
    }
    const resolved = resolveLocalExpression(sourceCode, node);
    if (resolved !== node) {
      return selectionFindings(
        sourceCode,
        resolved,
        allowUninspectable,
        visited,
      );
    }
    return allowUninspectable
      ? [{ node, messageId: "uninspectableResultSelection" }]
      : [];
  }
  if (node.type === AST_NODE_TYPES.ObjectExpression) {
    return node.properties.flatMap((property) => {
      if (property.type === AST_NODE_TYPES.SpreadElement) {
        return selectionFindings(sourceCode, property.argument, true, visited);
      }
      if (property.kind !== "init" || property.method) {
        return [{ node: property, messageId: "uninspectableResultSelection" }];
      }
      return selectionFindings(sourceCode, property.value, false, visited);
    });
  }
  if (node.type === AST_NODE_TYPES.ArrayExpression) {
    return node.elements.flatMap((element) => {
      if (element === null) {
        return [];
      }
      return selectionFindings(
        sourceCode,
        element.type === AST_NODE_TYPES.SpreadElement
          ? element.argument
          : element,
        element.type === AST_NODE_TYPES.SpreadElement,
        visited,
      );
    });
  }
  if (node.type === AST_NODE_TYPES.ConditionalExpression) {
    return [
      ...selectionFindings(
        sourceCode,
        node.consequent,
        allowUninspectable,
        visited,
      ),
      ...selectionFindings(
        sourceCode,
        node.alternate,
        allowUninspectable,
        visited,
      ),
    ];
  }
  if (node.type === AST_NODE_TYPES.LogicalExpression) {
    return [
      ...selectionFindings(sourceCode, node.left, allowUninspectable, visited),
      ...selectionFindings(sourceCode, node.right, allowUninspectable, visited),
    ];
  }
  if (node.type === AST_NODE_TYPES.CallExpression) {
    if (
      node.callee.type === AST_NODE_TYPES.MemberExpression &&
      memberName(node.callee) === "mapWith"
    ) {
      return [];
    }
    const returned = localFunctionReturn(sourceCode, node);
    if (returned !== null) {
      return selectionFindings(
        sourceCode,
        returned,
        allowUninspectable,
        visited,
      );
    }
    return isRawSqlExpression(sourceCode, node)
      ? [{ node, messageId: "unmappedResult" }]
      : [];
  }
  if (node.type === AST_NODE_TYPES.ExpressionStatement) {
    return selectionFindings(
      sourceCode,
      node.expression,
      allowUninspectable,
      visited,
    );
  }
  if (node.type === AST_NODE_TYPES.ReturnStatement && node.argument !== null) {
    return selectionFindings(
      sourceCode,
      node.argument,
      allowUninspectable,
      visited,
    );
  }
  return node.type === AST_NODE_TYPES.TaggedTemplateExpression &&
    isRawSqlExpression(sourceCode, node)
    ? [{ node, messageId: "unmappedResult" }]
    : [];
}

function relationalExtras(
  sourceCode: Parameters<typeof isDrizzleSqlTag>[0],
  node: TSESTree.Node,
): readonly SelectionFinding[] | null {
  const expression =
    node.type === AST_NODE_TYPES.Identifier
      ? resolveLocalExpression(sourceCode, node)
      : node;
  if (expression.type !== AST_NODE_TYPES.ObjectExpression) {
    return null;
  }
  const findings: SelectionFinding[] = [];
  for (const property of expression.properties) {
    if (property.type === AST_NODE_TYPES.SpreadElement) {
      return null;
    }
    const name = propertyName(property);
    if (name === "extras") {
      if (
        property.value.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        property.value.type === AST_NODE_TYPES.FunctionExpression
      ) {
        const returned =
          property.value.body.type === AST_NODE_TYPES.BlockStatement
            ? property.value.body.body.at(-1)
            : property.value.body;
        if (returned !== undefined) {
          findings.push(
            ...selectionFindings(
              sourceCode,
              returned,
              true,
              new Set<TSESTree.Node>(),
            ),
          );
        }
      } else {
        findings.push(
          ...selectionFindings(
            sourceCode,
            property.value,
            true,
            new Set<TSESTree.Node>(),
          ),
        );
      }
    }
    if (name === "with") {
      const nestedContainer =
        property.value.type === AST_NODE_TYPES.Identifier
          ? resolveLocalExpression(sourceCode, property.value)
          : property.value;
      if (nestedContainer.type !== AST_NODE_TYPES.ObjectExpression) {
        return null;
      }
      for (const relation of nestedContainer.properties) {
        if (relation.type === AST_NODE_TYPES.SpreadElement) {
          return null;
        }
        if (relation.value.type === AST_NODE_TYPES.Literal) {
          continue;
        }
        const nested = relationalExtras(sourceCode, relation.value);
        if (nested === null) {
          return null;
        }
        findings.push(...nested);
      }
    }
  }
  return findings;
}

function typeNameIsDrizzleSql(
  sourceCode: Parameters<typeof isDrizzleTypeReference>[0],
  node: TSESTree.TypeNode,
): boolean {
  return isDrizzleTypeReference(sourceCode, node, DRIZZLE_SQL_TYPES);
}

export const requireSqlResultMapping = createRule({
  name: "require-sql-result-mapping",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require runtime mapping for raw SQL values in conventional structured Drizzle results",
      recommended: true,
    },
    schema: [],
    messages: {
      sqlTypeArgument:
        "Drizzle sql<T> is compile-only. Remove the type argument; map selected values with a matching runtime decoder.",
      sqlTypeReference:
        "A generic Drizzle SQL type is compile-only. Use unparameterized SQL for composition and derive selected output from runtime mapping.",
      sqlAliasTypeArgument:
        'Generic SQL .as<T>(...) changes only the TypeScript type. Use .as("alias") after runtime mapping.',
      sqlAssertion:
        "A TypeScript assertion cannot establish a raw SQL runtime result contract.",
      resultMethodReference:
        "Do not alias or bind a Drizzle structured-result method. Call it directly so raw SQL result mapping can be enforced.",
      uninspectableResultArguments:
        "Do not spread arguments into a Drizzle structured-result method. Pass them explicitly so raw SQL result mapping can be enforced.",
      uninspectableResultSelection:
        "Structured-result fields must be inspectable so raw SQL runtime mapping can be enforced. Use an inline object or a local const selection.",
      uninspectableRelationalConfig:
        "Relational query config must be an inline object or a local const so raw SQL extras can be inspected.",
      unmappedResult:
        "Raw SQL in a structured Drizzle result must derive a concrete output from .mapWith(...) or a trusted schema-aware helper.",
      uninspectableResultDecoder:
        "Drizzle .mapWith(...) must use an inspectable schema column or reviewed runtime decoder.",
    },
  },
  create(context) {
    const reported = new WeakMap<TSESTree.Node, Set<MessageId>>();

    function report(node: TSESTree.Node, messageId: MessageId): void {
      const messages = reported.get(node) ?? new Set<MessageId>();
      if (messages.has(messageId)) {
        return;
      }
      messages.add(messageId);
      reported.set(node, messages);
      context.report({ node, messageId });
    }

    function checkResultCall(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        !isResultMethodMember(context.sourceCode, node.callee)
      ) {
        return;
      }
      const name = memberName(node.callee);
      if (name === null) {
        return;
      }
      for (const argument of node.arguments) {
        if (argument.type === AST_NODE_TYPES.SpreadElement) {
          report(argument, "uninspectableResultArguments");
        }
      }
      if (
        node.arguments.some(
          (argument) => argument.type === AST_NODE_TYPES.SpreadElement,
        )
      ) {
        return;
      }
      if (RELATIONAL_RESULT_METHODS.has(name)) {
        const config = node.arguments[0];
        if (config === undefined) {
          return;
        }
        const findings = relationalExtras(context.sourceCode, config);
        if (findings === null) {
          report(config, "uninspectableRelationalConfig");
          return;
        }
        for (const finding of findings) {
          report(finding.node, finding.messageId);
        }
        return;
      }
      const argumentIndex = RESULT_FIELD_ARGUMENT.get(name);
      const fields =
        argumentIndex === undefined ? undefined : node.arguments[argumentIndex];
      if (fields === undefined) {
        return;
      }
      for (const finding of selectionFindings(
        context.sourceCode,
        fields,
        true,
        new Set<TSESTree.Node>(),
      )) {
        report(finding.node, finding.messageId);
      }
    }

    function checkMapWith(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== "mapWith" ||
        !isRawSqlExpression(context.sourceCode, node.callee.object)
      ) {
        return;
      }
      const argument = node.arguments[0];
      if (
        node.arguments.length !== 1 ||
        argument === undefined ||
        argument.type === AST_NODE_TYPES.SpreadElement ||
        !hasReviewedDecoder(context.sourceCode, argument)
      ) {
        report(
          argument === undefined ||
            argument.type === AST_NODE_TYPES.SpreadElement
            ? node
            : argument,
          "uninspectableResultDecoder",
        );
      }
    }

    function checkAssertion(
      node: TSESTree.TSAsExpression | TSESTree.TSTypeAssertion,
    ): void {
      if (
        isRawSqlExpression(context.sourceCode, node.expression) &&
        !typeNameIsDrizzleSql(context.sourceCode, node.typeAnnotation)
      ) {
        report(node, "sqlAssertion");
      }
    }

    return {
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (
          node.typeArguments?.params.length &&
          isDrizzleSqlTag(context.sourceCode, node.tag)
        ) {
          report(node, "sqlTypeArgument");
        }
      },
      TSTypeReference(node: TSESTree.TSTypeReference): void {
        if (
          node.typeArguments?.params.length &&
          typeNameIsDrizzleSql(context.sourceCode, node)
        ) {
          report(node, "sqlTypeReference");
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        checkMapWith(node);
        if (
          node.typeArguments?.params.length &&
          isDrizzleSqlTag(context.sourceCode, node.callee)
        ) {
          report(node, "sqlTypeArgument");
        }
        if (
          node.typeArguments?.params.length &&
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          memberName(node.callee) === "as" &&
          isRawSqlExpression(context.sourceCode, node.callee.object)
        ) {
          report(node, "sqlAliasTypeArgument");
        }
        checkResultCall(node);
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (
          isResultMethodMember(context.sourceCode, node) &&
          !(
            node.parent.type === AST_NODE_TYPES.CallExpression &&
            node.parent.callee === node
          )
        ) {
          report(node, "resultMethodReference");
        }
      },
      TSAsExpression(node: TSESTree.TSAsExpression): void {
        checkAssertion(node);
      },
      TSTypeAssertion(node: TSESTree.TSTypeAssertion): void {
        checkAssertion(node);
      },
    };
  },
});
