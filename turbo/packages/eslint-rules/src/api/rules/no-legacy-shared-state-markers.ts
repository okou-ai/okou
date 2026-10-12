import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

const LEGACY_MARKERS = [
  "threadless-run-cleanup-integration-test",
  "threadlessRunCleanupIntegrationTest",
  "withThreadlessRunCleanupTestLock",
  "restore-storage-state",
  "restoreStorageState",
  "seed-storage-version",
  "seedStorageVersion",
  "delete-storage-version",
  "deleteStorageVersion",
  "SOLE OWNER",
  "resetSecretKmsClientForTests",
  "clearTeamsBotAuthCacheForTest",
] as const;

export const noLegacySharedStateMarkers = createRule({
  name: "no-legacy-shared-state-markers",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent deleted API test locks, shared storage restore markers, and process-cache resets from returning",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      legacyMarker:
        "Deleted shared-state convention '{{ marker }}' must not return. Use uniquely owned fixture state and scoped overrides instead. See docs/api/api-testing.md#shared-persistent-state.",
    },
  },
  create(context) {
    return {
      Program(node: TSESTree.Program) {
        for (const marker of LEGACY_MARKERS) {
          if (context.sourceCode.text.includes(marker)) {
            context.report({
              node,
              messageId: "legacyMarker",
              data: { marker },
            });
          }
        }
      },
    };
  },
});
