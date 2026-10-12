import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
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
