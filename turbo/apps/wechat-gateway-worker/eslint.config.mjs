import { namedZodImportsConfig } from "@okouai/eslint-rules/zod";
import { config, oxlint } from "@okouai/eslint-config/base";
export default [
  { ignores: ["dist/**", ".wrangler/**"] },
  ...config,
  namedZodImportsConfig,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
