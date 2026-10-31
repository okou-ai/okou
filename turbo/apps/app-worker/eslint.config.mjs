import { zodConfig } from "@okouai/eslint-rules/zod";
import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  { ignores: ["shell/**"] },
  ...config,
  zodConfig,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["tests/worker.test.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["src/preview-response.js"],
    languageOptions: { globals: { URL: "readonly" } },
  },
  {
    files: ["src/worker.js"],
    languageOptions: {
      globals: {
        fetch: "readonly",
        Headers: "readonly",
        HTMLRewriter: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      complexity: ["error", 25],
    },
  },
];
