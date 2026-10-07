import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const nativeHarness = "/src/test-fixtures/pglite-database.ts";

/** Keep PGlite imports and construction inside the shared database fixture. */
export const noTestDatabaseBinding = createRule({
  name: "no-test-database-binding",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep per-case PGlite construction in the owned database harness",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      harnessOnly:
        "Create/bind PGlite only in the case-owned database harness, not in individual API tests.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const ownsEngine = filename.endsWith(nativeHarness);
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (
          !ownsEngine &&
          (node.source.value.startsWith("@electric-sql/pglite") ||
            node.source.value === "drizzle-orm/pglite")
        ) {
          context.report({ node, messageId: "harnessOnly" });
        }
      },
      ImportExpression(node: TSESTree.ImportExpression) {
        if (
          !ownsEngine &&
          node.source.type === AST_NODE_TYPES.Literal &&
          typeof node.source.value === "string" &&
          (node.source.value.startsWith("@electric-sql/pglite") ||
            node.source.value === "drizzle-orm/pglite")
        ) {
          context.report({ node, messageId: "harnessOnly" });
        }
      },
      NewExpression(node: TSESTree.NewExpression) {
        if (
          !ownsEngine &&
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "PGlite"
        ) {
          context.report({ node, messageId: "harnessOnly" });
        }
      },
    };
  },
});
