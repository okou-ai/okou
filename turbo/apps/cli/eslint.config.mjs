import { config, oxlint } from "@okouai/eslint-config/base";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";

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
          allowed: [
            {
              file: "src/commands/ssh/__tests__/index.test.ts",
              kinds: ["fakeTimer"],
              reason:
                "The hung-helper 65-second process deadline is the documented CLI SSH exception in docs/testing/cli-testing.md.",
            },
            {
              file: "src/commands/ssh/__tests__/files.test.ts",
              kinds: ["fakeTimer"],
              reason:
                "The hung-helper 15-minute process deadline is the documented CLI SSH exception in docs/testing/cli-testing.md.",
            },
            {
              file: "src/lib/pi-agent-loop.test.ts",
              kinds: ["delay"],
              reason:
                "This is a bounded liveness deadline for a provider harness; issue #35594 explicitly permits deadline guards.",
            },
          ],
        },
      ],
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
