import { ESLintUtils } from "@typescript-eslint/utils";

export interface RuleDocs {
  readonly description: string;
  readonly recommended?: boolean;
  readonly requiresTypeChecking?: boolean;
}

export const createRule = ESLintUtils.RuleCreator<RuleDocs>((name) => {
  switch (name) {
    case "no-db-transaction":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/database.md#transaction-lint";
    case "no-database-trigger":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/database.md#database-triggers";
    case "max-signal-owner-lines":
      return "https://github.com/okou-ai/okou/blob/main/turbo/packages/eslint-rules/src/api/rules/max-signal-owner-lines.ts";
    default:
      return `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`;
  }
});
