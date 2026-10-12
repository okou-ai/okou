import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

import { databaseTriggerOffsets } from "../sql-analysis/database-triggers.ts";
import { createRule } from "../utils.ts";

export const noDatabaseTrigger = createRule({
  name: "no-database-trigger",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow creating PostgreSQL database triggers",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      databaseTrigger:
        "Do not create database triggers. Keep write orchestration explicit in application SQL, and use database constraints for invariants. See docs/api/database.md#database-triggers.",
    },
  },
  create(context) {
    const sqlFile = context.filename.endsWith(".sql");
    function check(node: TSESTree.Node): void {
      if (sqlFile) {
        return;
      }
      // A statically assembled parent owns its SQL, including data strings that
      // only become quoted after interpolation or concatenation.
      if (
        ((node.parent?.type === AST_NODE_TYPES.BinaryExpression &&
          node.parent.operator === "+") ||
          node.parent?.type === AST_NODE_TYPES.TemplateLiteral) &&
        typeof ASTUtils.getStaticValue(
          node.parent,
          context.sourceCode.getScope(node.parent),
        )?.value === "string"
      ) {
        return;
      }
      const value = ASTUtils.getStaticValue(
        node,
        context.sourceCode.getScope(node),
      )?.value;
      const source =
        typeof value === "string"
          ? value
          : node.type === AST_NODE_TYPES.TemplateLiteral
            ? node.quasis
                .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
                .join(" __interpolation__ ")
            : "";
      if (databaseTriggerOffsets(source).length > 0) {
        context.report({ node, messageId: "databaseTrigger" });
      }
    }
    return {
      Program(): void {
        if (!sqlFile) {
          return;
        }
        for (const offset of databaseTriggerOffsets(context.sourceCode.text)) {
          context.report({
            loc: {
              start: context.sourceCode.getLocFromIndex(offset),
              end: context.sourceCode.getLocFromIndex(offset + "CREATE".length),
            },
            messageId: "databaseTrigger",
          });
        }
      },
      Literal: check,
      TemplateLiteral: check,
      BinaryExpression: check,
    };
  },
});
