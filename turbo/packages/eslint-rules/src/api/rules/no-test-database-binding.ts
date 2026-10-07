import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

const nativeHarness = "/src/test-fixtures/pglite-database.ts";
const isolatedSuites = [
  "src/signals/routes/__tests__/test-runtime-state.test.ts",
] as const;

/** Bounded lexical guard; engine ownership/cleanup is verified by real SQL tests. */
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
      serialization:
        "A case-owned PGlite suite must not return to a serialized shared-database project.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const ownsEngine = filename.endsWith(nativeHarness);
    const arrays = new Map<string, TSESTree.ArrayExpression>();
    function includesIsolated(
      node: TSESTree.Node | null,
      seen = new Set<string>(),
    ): boolean {
      if (!node) {
        return false;
      }
      if (node.type === AST_NODE_TYPES.Literal) {
        return isolatedSuites.some((suite) => {
          return node.value === suite;
        });
      }
      if (node.type === AST_NODE_TYPES.ArrayExpression) {
        return node.elements.some((entry) => {
          return includesIsolated(entry, seen);
        });
      }
      if (node.type === AST_NODE_TYPES.SpreadElement) {
        return includesIsolated(node.argument, seen);
      }
      if (node.type === AST_NODE_TYPES.Identifier && !seen.has(node.name)) {
        const next = new Set(seen);
        next.add(node.name);
        return includesIsolated(arrays.get(node.name) ?? null, next);
      }
      return false;
    }
    function propertyName(node: TSESTree.Property): string | undefined {
      if (node.key.type === AST_NODE_TYPES.Identifier && !node.computed) {
        return node.key.name;
      }
      if (
        node.key.type === AST_NODE_TYPES.Literal &&
        typeof node.key.value === "string"
      ) {
        return node.key.value;
      }
      return undefined;
    }
    return {
      Program(node: TSESTree.Program) {
        for (const statement of node.body) {
          const declaration =
            statement.type === AST_NODE_TYPES.ExportNamedDeclaration
              ? statement.declaration
              : statement;
          if (declaration?.type !== AST_NODE_TYPES.VariableDeclaration) {
            continue;
          }
          for (const entry of declaration.declarations) {
            if (
              entry.id.type === AST_NODE_TYPES.Identifier &&
              entry.init?.type === AST_NODE_TYPES.ArrayExpression
            ) {
              arrays.set(entry.id.name, entry.init);
            }
          }
        }
      },
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
      Property(node: TSESTree.Property) {
        const name = propertyName(node);
        if (
          (name !== "fileParallelism" && name !== "concurrent") ||
          node.value.type !== AST_NODE_TYPES.Literal ||
          node.value.value !== false
        ) {
          return;
        }
        let container = node.parent;
        if (
          name === "concurrent" &&
          container.type === AST_NODE_TYPES.ObjectExpression &&
          container.parent.type === AST_NODE_TYPES.Property &&
          propertyName(container.parent) === "sequence"
        ) {
          container = container.parent.parent;
        }
        if (container.type !== AST_NODE_TYPES.ObjectExpression) {
          return;
        }
        const include = container.properties.find((entry) => {
          return (
            entry.type === AST_NODE_TYPES.Property &&
            propertyName(entry) === "include"
          );
        });
        if (
          include?.type === AST_NODE_TYPES.Property &&
          includesIsolated(include.value)
        ) {
          context.report({ node, messageId: "serialization" });
        }
      },
    };
  },
});
