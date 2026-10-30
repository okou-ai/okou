import { config, oxlint } from "@okouai/eslint-config/base";
import globals from "globals";

export default [
  { ignores: ["dist/**", "artifacts/**", "test-results/**"] },
  ...config,
  { languageOptions: { globals: globals.node } },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["tests/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
  },
];
