import { config, oxlint } from "@okouai/eslint-config/base";
import { apiLintPlugin } from "@okouai/eslint-rules/api";

export default [
  ...config,
  {
    ignores: [
      "**/dist/**",
      "scripts/migrations/00*/**",
      "scripts/migrations/01[0-2]*/**",
    ],
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    plugins: { api: apiLintPlugin },
    rules: { "api/no-new-advisory-lock": "error" },
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
