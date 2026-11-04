import { resolve } from "node:path";
import { zodConfig } from "@okouai/eslint-rules/zod";
import { clientContractsPlugin } from "@okouai/eslint-rules/client-contracts";
import { clientContractImportManifest } from "@okouai/api-contracts/client/imports";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  zodConfig,
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/__benches__/**",
      "src/**/*.{test,spec,bench}.ts",
      // These public compatibility barrels remain the server/CLI contract API.
      "src/index.ts",
      "src/contracts/index.ts",
    ],
    plugins: { "client-contracts": clientContractsPlugin },
    rules: {
      "client-contracts/prefer-client-descriptors": [
        "error",
        {
          modules: clientContractImportManifest,
          contractsDirectory: resolve(
            import.meta.dirname,
            "../api-contracts/src/contracts",
          ),
        },
      ],
    },
  },
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
