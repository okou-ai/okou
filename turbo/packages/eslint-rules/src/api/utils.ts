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
    case "no-test-vi-mocks":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#mocks";
    case "no-test-database-binding":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#case-owned-database-selection";
    case "no-global-sweep-test-routes":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#external-behavior-boundary";
    case "no-cross-test-time-staggering":
    case "no-legacy-shared-state-markers":
    case "no-production-staff-entitlement-mutation":
    case "no-unowned-usage-pricing":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#shared-persistent-state";
    case "no-test-private-access":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#no-private-state-access";
    case "no-test-only-routes":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#no-test-only-endpoints";
    case "no-test-credential-forging":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#credentials-from-real-flows";
    case "test-control-allowlist":
      return "https://github.com/okou-ai/okou/blob/main/docs/api/api-testing.md#boundary-test-controls";
    case "max-signal-owner-lines":
      return "https://github.com/okou-ai/okou/blob/main/turbo/packages/eslint-rules/src/api/rules/max-signal-owner-lines.ts";
    default:
      return `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`;
  }
});
