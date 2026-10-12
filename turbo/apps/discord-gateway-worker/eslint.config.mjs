import { config, oxlint } from "@okouai/eslint-config/base";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";

export default [
  { ignores: ["dist/**", ".wrangler/**"] },
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["src/__tests__/application-capabilities.test.ts"],
    plugins: { ccstate: ccstatePlugin },
    rules: {
      "ccstate/no-test-delay": [
        "error",
        {
          allowed: [
            {
              file: "src/__tests__/application-capabilities.test.ts",
              kinds: ["elapsedTime"],
              reason:
                "The Discord Retry-After contract runs through real Miniflare Worker alarms, not an application clock. Remove this exception with the protocol test or when that alarm boundary supports a deterministic clock.",
            },
          ],
        },
      ],
    },
  },
];
