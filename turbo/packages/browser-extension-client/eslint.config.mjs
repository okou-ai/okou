import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  { ignores: ["dist/**", "artifacts/**", "test-results/**"] },
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
