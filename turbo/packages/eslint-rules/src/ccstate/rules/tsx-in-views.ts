/**
 * ESLint rule: tsx-in-views
 *
 * Enforces that TSX/JSX files are only allowed in the views/ directory.
 * This maintains separation between UI components and business logic.
 *
 * Good: src/views/Dashboard.tsx
 * Bad: src/stores/userStore.tsx
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "tsxOutsideViews";

export default createRule<[], MessageIds>({
  name: "tsx-in-views",
  meta: {
    type: "problem",
    docs: {
      description: "Enforce TSX files are only allowed in views/ directory",
    },
    schema: [],
    messages: {
      tsxOutsideViews:
        "TSX files should only be in the views/ directory. Move '{{filename}}' to src/views/",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;
    const isTsxFile = filename.endsWith(".tsx");

    if (!isTsxFile) {
      return {};
    }

    const normalizedPath = filename.replace(/\\/g, "/");

    const viewsPattern = /\/src\/views\//;
    const testPattern = /\/__tests__\//;
    const isInViews = viewsPattern.test(normalizedPath);
    const isTestFile = testPattern.test(normalizedPath);

    if (isInViews || isTestFile) {
      return {};
    }

    return {
      Program(node) {
        context.report({
          node,
          messageId: "tsxOutsideViews",
          data: {
            filename: filename.split("/").pop() ?? filename,
          },
        });
      },
    };
  },
});
