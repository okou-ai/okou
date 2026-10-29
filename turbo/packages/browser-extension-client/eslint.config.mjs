import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  { ignores: ["dist/**", "artifacts/**", "test-results/**"] },
  ...config,
  {
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { AbortController: "readonly" } },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
