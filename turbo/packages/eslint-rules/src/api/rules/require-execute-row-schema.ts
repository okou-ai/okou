import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  isDatabaseExpression,
  isDrizzleExecuteCall,
  memberName,
  propertyName,
  resolveLocalExpression,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

function onlyDestructuresRowCount(pattern: TSESTree.BindingName): boolean {
  if (
    pattern.type !== AST_NODE_TYPES.ObjectPattern ||
    pattern.properties.length !== 1
  ) {
    return false;
  }
  const [property] = pattern.properties;
  return (
    property?.type === AST_NODE_TYPES.Property &&
    propertyName(property) === "rowCount"
  );
}

interface ExecuteUsage {
  readonly kind: "discarded" | "row-count" | "raw-result";
  readonly assertion: TSESTree.Node | null;
}

function resultAssertion(node: TSESTree.CallExpression): TSESTree.Node | null {
  let current: TSESTree.Node = node;

  while (current.parent) {
    const parent: TSESTree.Node = current.parent;
    if (
      (parent.type === AST_NODE_TYPES.AwaitExpression &&
        parent.argument === current) ||
      (parent.type === AST_NODE_TYPES.ChainExpression &&
        parent.expression === current) ||
      (parent.type === AST_NODE_TYPES.TSNonNullExpression &&
        parent.expression === current)
    ) {
      current = parent;
      continue;
    }
    if (
      (parent.type === AST_NODE_TYPES.TSAsExpression ||
        parent.type === AST_NODE_TYPES.TSTypeAssertion) &&
      parent.expression === current
    ) {
      return parent;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.CallExpression &&
      parent.callee === current
    ) {
      current = parent;
      continue;
    }
    break;
  }

  return null;
}

function executeUsage(node: TSESTree.CallExpression): ExecuteUsage {
  let current: TSESTree.Node = node;
  const assertion = resultAssertion(node);

  while (current.parent) {
    const parent: TSESTree.Node = current.parent;
    if (
      (parent.type === AST_NODE_TYPES.AwaitExpression &&
        parent.argument === current) ||
      (parent.type === AST_NODE_TYPES.ChainExpression &&
        parent.expression === current) ||
      (parent.type === AST_NODE_TYPES.TSNonNullExpression &&
        parent.expression === current) ||
      ((parent.type === AST_NODE_TYPES.TSAsExpression ||
        parent.type === AST_NODE_TYPES.TSTypeAssertion) &&
        parent.expression === current)
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current
    ) {
      return {
        kind: memberName(parent) === "rowCount" ? "row-count" : "raw-result",
        assertion,
      };
    }
    if (
      parent.type === AST_NODE_TYPES.VariableDeclarator &&
      parent.init === current
    ) {
      return {
        kind: onlyDestructuresRowCount(parent.id) ? "row-count" : "raw-result",
        assertion,
      };
    }
    if (
      parent.type === AST_NODE_TYPES.ExpressionStatement &&
      parent.expression === current
    ) {
      return { kind: "discarded", assertion };
    }
    return { kind: "raw-result", assertion };
  }

  return { kind: "raw-result", assertion };
}

function isRuntimeDecoded(
  sourceCode: Parameters<typeof importReference>[0],
  node: TSESTree.CallExpression,
): boolean {
  const awaited = node.parent;
  if (awaited.type !== AST_NODE_TYPES.AwaitExpression) {
    return false;
  }
  const decoder = awaited.parent;
  if (
    decoder.type !== AST_NODE_TYPES.CallExpression ||
    decoder.arguments.length !== 2 ||
    decoder.arguments[1] !== awaited ||
    decoder.arguments[0]?.type === AST_NODE_TYPES.SpreadElement
  ) {
    return false;
  }
  const callee = resolveLocalExpression(sourceCode, decoder.callee);
  const identifier =
    callee.type === AST_NODE_TYPES.Identifier
      ? callee
      : callee.type === AST_NODE_TYPES.MemberExpression
        ? resolveLocalExpression(sourceCode, callee.object)
        : null;
  if (identifier?.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }
  const imported = importReference(sourceCode, identifier);
  return (
    imported !== null &&
    !imported.isTypeOnly &&
    imported.source.startsWith(".") &&
    /(?:^|\/)lib\/db-raw-rows(?:\.[cm]?[jt]s)?$/u.test(imported.source) &&
    (callee.type === AST_NODE_TYPES.Identifier
      ? imported.importedName === "parseRawRows"
      : imported.importedName === "*" &&
        callee.type === AST_NODE_TYPES.MemberExpression &&
        memberName(callee) === "parseRawRows")
  );
}

export const requireExecuteRowSchema = createRule({
  name: "require-execute-row-schema",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require runtime schemas for rows returned by Drizzle execute",
      recommended: true,
    },
    schema: [],
    messages: {
      rowTypeArgument:
        "Drizzle execute row generics are compile-only. Remove the type argument and use executeRawRows(...) with a runtime schema.",
      rawResult:
        "Do not consume raw rows from Drizzle execute. Use executeRawRows(...) or parseRawRows(schema, await tx.execute(...)) with a runtime schema; otherwise direct execute is only for discarded results or rowCount.",
      assertedResult:
        "A TypeScript assertion does not validate a Drizzle execute result. Decode rows with executeRawRows(...) instead.",
      executeReference:
        "Do not alias Drizzle execute. Call it directly so result safety can be enforced.",
    },
  },
  create(context) {
    // ESTree decodes escaped identifiers and string literals. Every spelling
    // this rule recognizes either contains "execute" or uses a backslash escape.
    if (
      !context.sourceCode.text.includes("execute") &&
      !context.sourceCode.text.includes("\\")
    ) {
      return {};
    }

    function isDrizzleExecuteMember(node: TSESTree.MemberExpression): boolean {
      return (
        memberName(node) === "execute" &&
        isDatabaseExpression(context.sourceCode, node.object)
      );
    }

    function destructuresDrizzleExecute(node: TSESTree.Property): boolean {
      if (
        node.parent.type !== AST_NODE_TYPES.ObjectPattern ||
        propertyName(node) !== "execute"
      ) {
        return false;
      }
      const declarator = node.parent.parent;
      return (
        declarator.type === AST_NODE_TYPES.VariableDeclarator &&
        declarator.id === node.parent &&
        declarator.init !== null &&
        isDatabaseExpression(context.sourceCode, declarator.init)
      );
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          !isDrizzleExecuteCall(context.sourceCode, node)
        ) {
          return;
        }

        if (node.typeArguments?.params.length) {
          context.report({ node, messageId: "rowTypeArgument" });
        }

        const usage = executeUsage(node);
        if (usage.assertion) {
          context.report({
            node: usage.assertion,
            messageId: "assertedResult",
          });
        }
        if (
          usage.kind === "raw-result" &&
          !isRuntimeDecoded(context.sourceCode, node)
        ) {
          context.report({ node, messageId: "rawResult" });
        }
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (
          (node.parent.type === AST_NODE_TYPES.CallExpression &&
            node.parent.callee === node) ||
          !isDrizzleExecuteMember(node)
        ) {
          return;
        }
        context.report({ node, messageId: "executeReference" });
      },
      Property(node: TSESTree.Property): void {
        if (destructuresDrizzleExecute(node)) {
          context.report({ node, messageId: "executeReference" });
        }
      },
    };
  },
});
