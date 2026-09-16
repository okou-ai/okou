import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import css from "@eslint/css";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import { tailwind4 } from "tailwind-csstree";
import tseslint from "typescript-eslint";

const allowlist = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "style-allowlist.json"), "utf8"),
);

// The classes an allowlisted third-party DOM dependency puts on an element. The
// policy owns which file may carry each one and how often; this only keeps the
// unknown-class rule from flagging a name that is authorized somewhere.
const allowlistedClasses = allowlist.classDependencies.map((entry) => {
  return entry.token;
});

function exactRegex(value) {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

const productionSourceFiles = [
  "apps/platform/src/**/*.{ts,tsx}",
  "packages/ui/src/**/*.{ts,tsx}",
];
const testAndFixtureFiles = [
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/mocks/**",
  "**/test-fixtures/**",
  "**/*.test.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  "apps/platform/src/test/**",
  "packages/ui/src/test/**",
];

export default [
  {
    files: ["apps/platform/src/**/*.css", "packages/ui/src/**/*.css"],
    ignores: [
      "apps/platform/src/views/css/vendor/uiw-react-markdown-preview-5.2.0.css",
    ],
    language: "css/css",
    languageOptions: {
      customSyntax: tailwind4,
    },
    plugins: { css },
    rules: {
      "css/no-empty-blocks": "error",
    },
  },
  {
    files: productionSourceFiles,
    ignores: testAndFixtureFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "better-tailwindcss": betterTailwindcss,
    },
    settings: {
      "better-tailwindcss": {
        cwd: resolve(import.meta.dirname, "apps/platform"),
        detectComponentClasses: false,
        entryPoint: resolve(
          import.meta.dirname,
          "apps/platform/src/views/css/index.css",
        ),
        tsconfig: resolve(import.meta.dirname, "apps/platform/tsconfig.json"),
      },
    },
    rules: {
      "better-tailwindcss/no-unknown-classes": [
        "error",
        {
          attributes: ["class", "className", "contentClassName"],
          ignore: allowlistedClasses.map(exactRegex),
        },
      ],
    },
  },
];
