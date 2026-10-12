import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config, oxlint } from "@okouai/eslint-config/base";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";

const packageRoot = dirname(fileURLToPath(import.meta.url));

// Test exception entries name exact files. A missing path is a stale entry, so
// loading this config fails instead of letting dead exemptions accumulate.
function existingTestExceptions(entries) {
  for (const entry of entries) {
    if (!fs.existsSync(resolve(packageRoot, entry.file))) {
      throw new Error(
        `ccstate/no-test-delay lists a missing file: ${entry.file}. Remove the stale entry.`,
      );
    }
  }
  return entries;
}

export default [
  ...config,
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
    ],
    rules: {
      "okou/no-abort-signal-in-object-params": "error",
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    plugins: { ccstate: ccstatePlugin },
    rules: {
      "ccstate/no-test-delay": [
        "error",
        {
          allowed: existingTestExceptions([
            {
              file: "src/commands/ssh/__tests__/index.test.ts",
              kinds: ["fakeTimer"],
              reason:
                "The hung-helper 65-second process deadline is the documented CLI SSH exception in docs/cli/cli-testing.md.",
            },
            {
              file: "src/commands/ssh/__tests__/files.test.ts",
              kinds: ["fakeTimer"],
              reason:
                "The hung-helper 15-minute process deadline is the documented CLI SSH exception in docs/cli/cli-testing.md.",
            },
            {
              file: "src/lib/pi-agent-loop.test.ts",
              kinds: ["delay"],
              reason:
                "This is a bounded liveness deadline for a provider harness; issue #35594 explicitly permits deadline guards.",
            },
          ]),
        },
      ],
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
