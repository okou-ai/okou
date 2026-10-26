import { AST_NODE_TYPES, ESLintUtils } from "@typescript-eslint/utils";

const documentationUrl =
  "https://github.com/okou-ai/okou/blob/main/docs/zod-imports.md";

const aggregateDefaultSources = new Set([
  "zod",
  "zod/v3",
  "zod/v4",
  "zod/v4/classic",
  "zod/mini",
  "zod/v4/mini",
]);

const createRule = ESLintUtils.RuleCreator(() => {
  return documentationUrl;
});

export const namedZodImports = createRule({
  name: "named-imports",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Require explicit named Zod imports, including named types",
    },
    schema: [],
    messages: {
      aggregateImport:
        'Import the Zod members you use explicitly, for example import { object, string } from "zod", and use named type imports for types. Do not import the aggregate z, a default export, or a module namespace. See {{documentationUrl}}.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source !== "zod" && !source.startsWith("zod/")) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier &&
            !aggregateDefaultSources.has(source)
          ) {
            continue;
          }
          if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            const importedName =
              specifier.imported.type === AST_NODE_TYPES.Identifier
                ? specifier.imported.name
                : specifier.imported.value;
            if (
              importedName !== "z" &&
              !(
                importedName === "default" &&
                aggregateDefaultSources.has(source)
              )
            ) {
              continue;
            }
          }

          context.report({
            node: specifier,
            messageId: "aggregateImport",
            data: { documentationUrl },
          });
        }
      },
    };
  },
});
