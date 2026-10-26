import { namedZodImportsConfig } from "@okouai/eslint-rules/zod";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  namedZodImportsConfig,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
