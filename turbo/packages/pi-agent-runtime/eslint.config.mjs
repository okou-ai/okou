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
    ],
    rules: {
      "okou/no-abort-signal-in-object-params": "error",
    },
  },
  {
    files: ["src/index.ts", "src/node.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
