import { config, oxlint } from "@okouai/eslint-config/base";
import {
  apiLintPlugin,
  sqlSourceParser,
  transactionSqlParser,
} from "@okouai/eslint-rules/api";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    plugins: { api: apiLintPlugin },
    rules: { "api/no-new-advisory-lock": "error" },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    ignores: [
      "**/__tests__/**",
      "**/fixtures/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/test-*.ts",
    ],
    rules: { "api/no-database-trigger": "error" },
  },
  {
    // The current trigger inventory is production schema policy, even though
    // its assertions live in a test script. Existing entries are waived inline.
    files: ["scripts/test-migration-consistency-schema.ts"],
    rules: { "api/no-database-trigger": "error" },
  },
  {
    name: "database-trigger-sql",
    files: ["**/*.sql"],
    ignores: ["scripts/fixtures/**"],
    languageOptions: { parser: sqlSourceParser },
    plugins: { api: apiLintPlugin },
    rules: { "api/no-database-trigger": "error" },
  },
  {
    // Shipped migrations are immutable. Keep this list explicit so new
    // migrations cannot inherit an exemption by their number or journal entry.
    files: [
      "src/migrations/1078_baseline.sql",
      "src/migrations/1090_show_usage_pack.sql",
      "src/migrations/1098_retire_member_invitation_capability.sql",
      "src/migrations/1110_invalidate_marketing_privacy_epochs.sql",
      "src/migrations/1119_billing_attribution_capture.sql",
      "src/migrations/1171_hosted_publication_manifest_versions.sql",
      "src/migrations/1203_cloudflare_access_org_scope.sql",
      "src/migrations/1217_chat_event_sequence_bridge.sql",
    ],
    rules: { "api/no-database-trigger": "off" },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    plugins: { api: apiLintPlugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "api/no-db-transaction": "error",
      "api/db-transaction-exemptions": "error",
    },
  },
  {
    files: ["**/*.sql"],
    languageOptions: { parser: transactionSqlParser },
    plugins: { api: apiLintPlugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "api/no-db-transaction": "error",
      "api/db-transaction-exemptions": "error",
    },
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/schema/*.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
