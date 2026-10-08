import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  { ignores: ["dist/**", ".wrangler/**"] },
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
