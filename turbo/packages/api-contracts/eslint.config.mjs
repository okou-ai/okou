import { resolve } from "node:path";
import { namedZodImportsConfig } from "@okouai/eslint-rules/zod";
import { clientContractsPlugin } from "@okouai/eslint-rules/client-contracts";
import { clientContractImportManifest } from "./src/client/imports.ts";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  namedZodImportsConfig,
  {
    files: [
      "src/validators/**/*.ts",
      "src/client/types.ts",
      "src/client/transport.ts",
      "src/client/response-validation.ts",
      ...clientContractImportManifest.map(({ module }) => {
        return `src/client/${module}.ts`;
      }),
    ],
    ignores: [
      "src/**/__tests__/**",
      "src/**/__benches__/**",
      "src/**/*.{test,spec,bench}.ts",
    ],
    plugins: { "client-contracts": clientContractsPlugin },
    rules: {
      "client-contracts/prefer-client-descriptors": [
        "error",
        {
          modules: clientContractImportManifest,
          contractsDirectory: resolve(import.meta.dirname, "src/contracts"),
        },
      ],
    },
  },
  {
    ignores: ["**/dist/**"],
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/contracts/*.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  // Contracts describe production endpoints only; test-only HTTP surfaces are
  // prohibited. See docs/api/api-testing.md#no-test-only-endpoints.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: String.raw`Literal[value=/^\/api\/test(\/|$)/]`,
          message:
            'Test-only "/api/test" contract paths are prohibited. See docs/api/api-testing.md#no-test-only-endpoints.',
        },
        {
          selector: String.raw`TemplateElement[value.raw=/^\/api\/test(\/|$)/]`,
          message:
            'Test-only "/api/test" contract paths are prohibited. See docs/api/api-testing.md#no-test-only-endpoints.',
        },
      ],
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
