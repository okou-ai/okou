import { namedZodImportsConfig } from "@okouai/eslint-rules/zod";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  namedZodImportsConfig,
  {
    ignores: ["**/dist/**"],
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/*.ts", "src/contracts/index.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
