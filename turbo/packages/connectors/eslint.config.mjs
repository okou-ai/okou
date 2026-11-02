import { zodConfig } from "@okouai/eslint-rules/zod";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  zodConfig,
  {
    ignores: ["**/dist/**"],
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/auth-providers/connectors/test-oauth/**",
    ],
    rules: {
      "okou/no-abort-signal-in-object-params": "error",
    },
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/firewall-types.ts", "src/firewall-metadata/policy.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
