import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noLegacySharedStateMarkers } from "../rules/no-legacy-shared-state-markers.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-legacy-shared-state-markers", noLegacySharedStateMarkers, {
  valid: [
    {
      name: "owned system-storage actions remain valid",
      code: `
        const action = "seed-owned-storage-version";
        await seedOwnedStorageVersion({ storageId, versionId });
      `,
    },
    {
      name: "legitimate owned cleanup remains valid",
      code: `
        afterEach(() => server.resetHandlers());
        onTestFinished(async () => {
          controller.abort();
          connection.close();
          await detachedTask;
          rmSync(tempFile);
        });
      `,
    },
    {
      name: "scoped process override remains valid",
      code: `
        const cache = teamsBotAuthCacheForSignal(context.signal);
      `,
    },
  ],
  invalid: [
    {
      code: `const marker = "threadless-run-cleanup-integration-test";`,
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: `await withThreadlessRunCleanupTestLock(run);`,
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: "const action = `restore-storage-state`;",
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: `const action = "seed-storage-version";`,
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: `const action = "delete-storage-version";`,
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: `// SOLE OWNER: this file restores the global row\nrun();`,
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: `resetSecretKmsClientForTests();`,
      errors: [{ messageId: "legacyMarker" }],
    },
    {
      code: `clearTeamsBotAuthCacheForTest();`,
      errors: [{ messageId: "legacyMarker" }],
    },
  ],
});
