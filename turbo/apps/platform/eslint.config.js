import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as baseConfig, oxlint } from "@okouai/eslint-config/base";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginReact from "eslint-plugin-react";

const eslintCacheInputPaths = globSync(
  [
    "eslint.config.js",
    "package.json",
    "../../package.json",
    "../../pnpm-lock.yaml",
    "../../pnpm-workspace.yaml",
    "../../turbo.{json,jsonc}",
    "../../{apps,packages}/*/turbo.{json,jsonc}",
    "../../packages/eslint-config/**/*.{js,cjs,mjs,json}",
    "../../packages/eslint-rules/package.json",
    "../../packages/eslint-rules/src/ccstate/**/*.ts",
  ],
  {
    cwd: import.meta.dirname,
    exclude: [
      "../../packages/eslint-config/**/*.node.js",
      "../../packages/eslint-rules/src/ccstate/__tests__/**",
    ],
  },
).sort();
const eslintCacheHash = createHash("sha256");

// Cached results must only depend on the linted file, its calculated config,
// and the inputs above. Add new external inputs here before enabling a rule
// that reads them; type-aware or other cross-file rules need broader invalidation.
for (const inputPath of eslintCacheInputPaths) {
  eslintCacheHash.update(inputPath).update("\0");
  eslintCacheHash
    .update(readFileSync(resolve(import.meta.dirname, inputPath)))
    .update("\0");
}

const eslintCacheFingerprint = eslintCacheHash.digest("hex");

const runtimeImportRestrictions = Object.freeze([
  Object.freeze({
    name: "ably",
    allowTypeImports: true,
    message:
      "Use src/lib/ably-realtime.ts for the modular runtime; direct imports are type-only.",
  }),
  Object.freeze({
    name: "@clerk/clerk-js",
    message:
      "Use src/lib/clerk-runtime.ts so Clerk loads the official browser runtime without bundled wallet adapters.",
  }),
]);

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...baseConfig,
  {
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: { version: "detect" },
      "okou/eslint-cache-fingerprint": eslintCacheFingerprint,
    },
  },
  {
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    plugins: {
      ccstate: ccstatePlugin,
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      // Moved to oxlint (react plugin) — not in eslint-plugin-oxlint mapping, explicit off required.
      "react/require-render-return": "off",
      // Redundant in TypeScript projects (type system enforces these) and not in oxlint.
      "react/prop-types": "off",
      "react/no-deprecated": "off",
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
      "ccstate/test-context-in-hooks": "error",
      // setupPage now always renders the complete Router, including from
      // signal-oriented integration tests.
      "ccstate/setup-page-render": "off",
      "ccstate/no-side-effect-in-render": "error",
      "ccstate/no-new-abort-controller": "error",
      "ccstate/no-create-child-abort-controller": "error",
      "ccstate/no-new-promise": "error",
      "ccstate/no-direct-local-storage": "error",
      "ccstate/no-direct-session-storage": "error",
      "ccstate/no-detach-in-signals": "error",
      "ccstate/no-direct-fetch": "error",
      "ccstate/no-empty-promise-catch": "error",
      "ccstate/no-void-statement": "error",
      "ccstate/no-abort-swallower": "error",
      "ccstate/no-react-class-component": "error",
      "ccstate/prefer-ui-components": "error",
      "ccstate/require-accept": "error",
      "ccstate/require-client-signal": "error",
      "ccstate/command-async-signal": "error",
      "ccstate/no-command-in-command": "error",
      "ccstate/no-computed-signal": "error",
      "ccstate/no-getter-setter-params": "error",
      "ccstate/no-accessor-escape": "error",
      "ccstate/no-store-in-params": [
        "error",
        {
          // setupRouter is the app-boundary bootstrap function that must bridge
          // the Store instance into React's StoreProvider context system.
          allowedFunctions: ["setupRouter"],
        },
      ],
      "ccstate/no-get-signal": "error",
      "ccstate/no-package-variable": "error",
      "ccstate/computed-const-args-package-scope": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/**/test-context.{ts,tsx}",
      "src/signals/fetch.ts",
    ],
    rules: {
      "okou/no-abort-signal-in-object-params": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/time.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message:
            "Use now() from src/lib/time instead of Date.now() so tests can control the platform clock.",
        },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "ccstate/no-test-delay": "error",
      "ccstate/no-manual-mock-cleanup": "error",
      "ccstate/no-get-by-role-name": "error",
      "ccstate/no-user-clear-tab": "error",
      "ccstate/no-mockapi-raw-async": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^(it|test)$/][arguments.2.type='Literal']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Use event-driven synchronization or setLoop, never handwritten loops with sleep/delay. Find and fix the underlying timing issue instead.",
        },
        {
          selector:
            "CallExpression[callee.name='describe'][arguments.2.type='Literal']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Use event-driven synchronization or setLoop, never handwritten loops with sleep/delay. Find and fix the underlying timing issue instead.",
        },
        {
          selector:
            "CallExpression[callee.name='waitFor'] > ObjectExpression > Property[key.name='timeout']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Use event-driven synchronization or setLoop, never handwritten loops with sleep/delay. Find and fix the underlying timing issue instead.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/**/__tests__/**/*.{ts,tsx}",
    ],
    ignores: ["src/signals/__tests__/test-helpers.ts"],
    rules: {
      "ccstate/no-test-after-each": "error",
    },
  },
  {
    files: ["src/mocks/**/*.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  // Enforce unique route param names in route definitions
  {
    files: ["src/signals/route-paths.ts"],
    rules: {
      "ccstate/no-duplicate-route-param": "error",
    },
  },
  // Allow detach() in signal infrastructure (definition site)
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "ccstate/no-detach-in-signals": "off",
    },
  },
  // Active transport and lifecycle boundaries are documented in docs/platform-lint.md.
  {
    files: ["src/lib/resource-fetch.ts"],
    rules: { "ccstate/no-direct-fetch": "off" },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/signals/utils.ts"],
    rules: { "ccstate/no-manual-polling": "error" },
  },
  ...[
    ["src/signals/location.ts", "LocationOverrides"],
    ["src/signals/utils.ts", "PromiseTracker"],
    ["src/signals/log.ts", "LoggerRegistry"],
  ].map(([file, constructor]) => {
    return {
      files: [file],
      rules: {
        "ccstate/no-package-variable": [
          "error",
          { allowedConstructors: [constructor] },
        ],
      },
    };
  }),
  // Allow direct localStorage in the abstraction layer only
  {
    files: ["src/signals/external/local-storage.ts"],
    rules: {
      "ccstate/no-direct-local-storage": "off",
    },
  },
  // Only primitive implementations may construct deferred promises.
  {
    files: ["src/signals/utils.ts", "src/polyfill.ts"],
    rules: {
      "ccstate/no-new-promise": "off",
    },
  },
  // Root lifetimes are created here; callers inherit a parent or use resetSignal().
  {
    files: [
      "src/signals/utils.ts",
      "src/polyfill.ts",
      "src/signals/__tests__/test-helpers.ts",
    ],
    rules: {
      "ccstate/no-new-abort-controller": "off",
    },
  },
  // Ban try statements and raw .then()/.catch() in production source code.
  // - try/catch: use accept() for API errors, useLoadableSet for loading states.
  // - .then/.catch: production code must await and surface state via ccstate
  //   loadables; the centralized helpers in signals/utils.ts (bestEffort,
  //   tapError, onRejection, settle, toVoid, detach) wrap the legitimate
  //   Promise primitive usage — see issue #13535.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/__tests__/**",
      "src/mocks/**",
      // Infrastructure: utils.ts implements the centralized Promise helpers,
      // so it is exempted from the .then/.catch ban via the override below.
      "src/signals/utils.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try statements are not allowed. Use accept() for API errors, useLoadableSet for loading states.",
        },
        {
          // KaTeX is the sole optional runtime boundary. The production build
          // separately enforces that it remains the only lazy JavaScript chunk.
          selector: "ImportExpression:not([source.value='katex'])",
          message:
            'Dynamic JavaScript imports other than import("katex") are not allowed. Keep application code in the single bundle; locale resources remain separate JSON assets.',
        },
        {
          selector: "CallExpression[callee.property.name='then']",
          message:
            "Promise.then is not allowed. Use await, or one of the helpers in signals/utils.ts (bestEffort, tapError, onRejection, settle, toVoid).",
        },
        {
          selector: "CallExpression[callee.property.name='catch']",
          message:
            "Promise.catch is not allowed. Use the helpers in signals/utils.ts (bestEffort, tapError, onRejection, settle).",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  // utils.ts hosts the centralized Promise helpers that wrap try/catch and
  // .then/.catch. Keep the try-statement ban so new try blocks still need
  // explicit per-line opt-out, but allow .then/.catch in the helper bodies.
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try statements are not allowed. Use accept() for API errors, useLoadableSet for loading states.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  // Every catch in production source must re-throw cancellation before it does
  // anything else, so an aborted page never reports a failure or persists a
  // fallback. The ignore list matches the try-statement ban above: test and
  // mock code carries no abort contract, and utils.ts implements the
  // centralized helpers (onRejection, settle, tapError) whose whole purpose is
  // to observe a rejection — including an abort — before re-throwing it.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/__tests__/**", "src/mocks/**", "src/signals/utils.ts"],
    rules: {
      "ccstate/no-catch-abort": "error",
    },
  },
  {
    ignores: [
      "dist/**",
      "public/**",
      "vite.config.ts",
      "vitest.config.ts",
      "src/mocks/**",
      "src/__tests__/**/*",
      // Keep startup child-signal debt visible to the lifecycle rules.
      "!src/__tests__/authentication-startup.test.tsx",
      // Asset files — not JS/TS, would cause parse errors when matched by
      // broad file globs in .oxlintrc.json overrides (e.g. src/views/**/*.*)
      "**/*.svg",
      "**/*.png",
      "**/*.webp",
      "**/*.css",
    ],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...runtimeImportRestrictions,
            {
              name: "@base-ui/react/dialog",
              message:
                "Use DialogContent from @okouai/ui. The shared dialog owns safe-area bounds, sizing, scrolling, and native focus behavior.",
            },
            {
              name: "@base-ui/react",
              importNames: ["Dialog"],
              message:
                "Use DialogContent from @okouai/ui so dialogs retain their safe-area boundary.",
            },
            {
              name: "@clerk/ui",
              allowTypeImports: true,
              message:
                "Only src/clerk-ui.ts imports the optional UI at runtime; use ensureClerkUiLoaded$ on v1 routes. Other imports must be type-only.",
            },
          ],
          patterns: [
            {
              group: ["@base-ui/react/dialog/*"],
              message:
                "Use the shared DialogContent instead of constructing a dialog viewport in business code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/clerk-ui.ts"],
    rules: {
      // Only this independent build entry may import the optional UI at runtime.
      "no-restricted-imports": [
        "error",
        { paths: [...runtimeImportRestrictions] },
      ],
    },
  },
  // react/jsx-uses-vars marked JSX identifiers as "used" for ESLint's no-unused-vars.
  // Both no-unused-vars and @typescript-eslint/no-unused-vars are now handled by
  // oxlint, so this rule is no longer needed.
  { rules: { "react/jsx-uses-vars": "off" } },
];
