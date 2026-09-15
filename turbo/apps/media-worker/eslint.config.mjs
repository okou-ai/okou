import { config, oxlint } from "@okouai/eslint-config/base";
export default [
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
