import { zodConfig } from "@okouai/eslint-rules/zod";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";
import { config, oxlint } from "@okouai/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  zodConfig,
  {
    plugins: { ccstate: ccstatePlugin },
    rules: {
      "ccstate/require-anchor-href": "error",
    },
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/index.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
