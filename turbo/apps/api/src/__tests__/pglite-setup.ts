import "./external-setup";
import { aroundEach, vi } from "vitest";
import { withPgliteDatabase } from "../test-fixtures/pglite-database";
import { seedIsolatedModelPricingForTests } from "../test-fixtures/usage-pricing";
import { installSharedApiTestConnectorCatalog } from "../test-fixtures/connector-catalog";
import { clearAllDetached } from "../signals/utils";
import { flushWaitUntilForTest } from "../signals/context/wait-until";

// Only the transport binding changes. SQL, schema, routes, services and fixture
// writers remain real; the binding fails closed outside a case's async scope.
vi.mock("../lib/db", async () => {
  const { pgliteDatabase } = await import("../test-fixtures/pglite-database");
  return {
    db: pgliteDatabase,
    // testContext calls this at suite end; each case already owns engine close.
    closeDbPool: async () => {},
  };
});

aroundEach(async (runTest) => {
  await withPgliteDatabase(
    async () => {
      await seedIsolatedModelPricingForTests();
      await installSharedApiTestConnectorCatalog();
      await runTest();
    },
    async () => {
      // testContext's afterEach aborts the case signal before this outer scope
      // drains. Keep native SQL alive until both work trackers have finished.
      await clearAllDetached();
      await flushWaitUntilForTest();
    },
  );
});
