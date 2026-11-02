import { zodConfig } from "@okouai/eslint-rules/zod";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  zodConfig,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
