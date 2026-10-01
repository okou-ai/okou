import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noUnownedUsagePricing } from "../rules/no-unowned-usage-pricing.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const fixtureModule = "../../../test-fixtures/system-config-seeds";

ruleTester.run("no-unowned-usage-pricing", noUnownedUsagePricing, {
  valid: [
    {
      name: "canonical logical providers belong in the scoped fixture",
      code: `
        import { createUsagePricingFixture } from "${fixtureModule}";
        const pricing = await createUsagePricingFixture({ configured: [{
          kind: "generation",
          provider: "google-weather",
          category: "air",
          unitPrice: 1,
          unitSize: 1,
        }] });
        onTestFinished(pricing.cleanup);
      `,
    },
    {
      name: "raw UUID-owned provider is allowed",
      code: `
        import { randomUUID } from "node:crypto";
        import { seedUsagePricingRows } from "${fixtureModule}";
        const provider = "fixture-" + randomUUID();
        await seedUsagePricingRows([{ kind: "model", provider, category: "input", unitPrice: 1, unitSize: 1 }]);
      `,
    },
    {
      name: "actual run-owned and fixture lookup-provider rows are allowed",
      code: `
        import { createAppWithRoutes } from "../../../app-factory-core";
        import { createUsagePricingFixture, seedUsagePricingRows, deleteUsagePricingRows } from "${fixtureModule}";
        import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
        import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
        const api = createRunsApi(context);
        const run = await api.createThreadRun(actor, request);
        function requestState(body) {
          return createAppWithRoutes({ routes: testCronCleanupSandboxesStateRoutes }).request("/state", { body: JSON.stringify(body) });
        }
        async function postState(body) {
          return await requestState(body);
        }
        async function insertRunFixture() {
          const response = await postState({ action: "seed-run" });
          return { runId: stringField(response, "run_id") };
        }
        const scopedRun = await trackRun(insertRunFixture());
        const pricing = await createUsagePricingFixture({ configured: [{ kind: "model", provider: "openrouter", category: "input", unitPrice: 1, unitSize: 1 }] });
        await seedUsagePricingRows([{ kind: "model", provider: run.runId, category: "input", unitPrice: 1, unitSize: 1 }]);
        await seedUsagePricingRows([{ kind: "model", provider: "cleanup-test-" + scopedRun.runId, category: "input", unitPrice: 1, unitSize: 1 }]);
        await deleteUsagePricingRows({ kind: "model", provider: pricing.resolution[0].lookupProvider, categories: ["input"] });
      `,
    },
    {
      name: "wrapper parameter is proven UUID-owned at every callsite",
      code: `
        import { randomUUID } from "node:crypto";
        import { upsertUsagePricingRows } from "${fixtureModule}";
        async function seed(provider) {
          await upsertUsagePricingRows([{ kind: "model", provider, category: "input", unitPrice: 1, unitSize: 1 }]);
        }
        await seed(randomUUID());
        await seed("fixture-" + randomUUID());
      `,
    },
    {
      name: "UUID-owned wrapper parameters remain proven through row mapping",
      code: `
        import { randomUUID } from "node:crypto";
        import { seedUsagePricingRows } from "${fixtureModule}";
        function uniqueProvider(prefix) { return prefix + "-" + randomUUID(); }
        async function seed(provider) {
          await seedUsagePricingRows(["input", "output"].map((category) => {
            return { kind: "model", provider, category, unitPrice: 1, unitSize: 1 };
          }));
        }
        await seed(uniqueProvider("fixture"));
      `,
    },
    {
      name: "owned handle cleanup is unrelated and remains valid",
      code: `
        afterEach(() => server.resetHandlers());
        onTestFinished(async () => {
          controller.abort();
          socket.close();
          await detachedWork;
          rmSync(tempFile);
        });
      `,
    },
  ],
  invalid: [
    {
      name: "seed-run ownership must match the actual scoped request action",
      code: `
        import { createAppWithRoutes } from "../../../app-factory-core";
        import { seedUsagePricingRows } from "${fixtureModule}";
        import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
        async function requestState(body) {
          return await createAppWithRoutes({ routes: testCronCleanupSandboxesStateRoutes })
            .request("/state", { body: JSON.stringify({ action: "read-state" }) });
        }
        async function insertRunFixture() {
          const response = await requestState({ action: "seed-run" });
          return { runId: stringField(response, "run_id") };
        }
        const run = await insertRunFixture();
        await seedUsagePricingRows([{ kind: "generation", provider: run.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "discarded scoped response cannot bless a fixed returned run id",
      code: `
        import { createAppWithRoutes } from "../../../app-factory-core";
        import { seedUsagePricingRows } from "${fixtureModule}";
        import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
        async function requestState(body) {
          void createAppWithRoutes({ routes: testCronCleanupSandboxesStateRoutes })
            .request("/state", { body: JSON.stringify(body) });
          return { run_id: "google-maps" };
        }
        async function insertRunFixture() {
          const response = await requestState({ action: "seed-run" });
          return { runId: stringField(response, "run_id") };
        }
        const run = await insertRunFixture();
        await seedUsagePricingRows([{ kind: "generation", provider: run.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "raw canonical overwrite is rejected",
      code: `
        import { upsertUsagePricingRows } from "${fixtureModule}";
        await upsertUsagePricingRows([{ kind: "generation", provider: "google-weather", category: "air", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "const alias cannot hide a fixed provider",
      code: `
        import { seedUsagePricingRows } from "${fixtureModule}";
        const PROVIDER = "dataforseo";
        await seedUsagePricingRows([{ kind: "generation", provider: PROVIDER, category: "seo", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "fixed pricing deletion is rejected",
      code: `
        import { deleteUsagePricingRows } from "${fixtureModule}";
        await deleteUsagePricingRows({ kind: "generation", provider: "joggai", categories: ["avatar-video"] });
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "restore of previously deleted fixed rows is rejected",
      code: `
        import { upsertUsagePricingRows } from "${fixtureModule}";
        const previousRows = [{ kind: "generation", provider: "x", category: "image-share", unitPrice: 1, unitSize: 1 }];
        await upsertUsagePricingRows(previousRows);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "unproven wrapper parameter is fail-closed",
      code: `
        import { seedUsagePricingRows } from "${fixtureModule}";
        async function seed(provider) {
          await seedUsagePricingRows([{ kind: "model", provider, category: "input", unitPrice: 1, unitSize: 1 }]);
        }
        await seed(process.env.PROVIDER);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "arbitrary lookupProvider property is not ownership",
      code: `
        import { upsertUsagePricingRows } from "${fixtureModule}";
        const fake = { lookupProvider: "google-maps" };
        await upsertUsagePricingRows([{ kind: "generation", provider: fake.lookupProvider, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "arbitrary runId property is not ownership",
      code: `
        import { seedUsagePricingRows } from "${fixtureModule}";
        const fake = { runId: "google-maps" };
        await seedUsagePricingRows([{ kind: "generation", provider: fake.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "a local function named randomUUID is not UUID provenance",
      code: `
        import { seedUsagePricingRows } from "${fixtureModule}";
        function randomUUID() { return "google-maps"; }
        await seedUsagePricingRows([{ kind: "generation", provider: randomUUID(), category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "an arbitrary randomUUID import is not UUID provenance",
      code: `
        import { randomUUID } from "arbitrary-uuid-helper";
        import { seedUsagePricingRows } from "${fixtureModule}";
        await seedUsagePricingRows([{ kind: "generation", provider: randomUUID(), category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "fake member and local run factories cannot manufacture ownership",
      code: `
        import { seedUsagePricingRows } from "${fixtureModule}";
        import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
        const fake = { createThreadRun() { return { runId: "google-maps" }; } };
        const run = fake.createThreadRun();
        function insertRunFixture() {
          void testCronCleanupSandboxesStateRoutes;
          return { runId: "google-maps" };
        }
        const localRun = insertRunFixture();
        await seedUsagePricingRows([{ kind: "generation", provider: run.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
        await seedUsagePricingRows([{ kind: "generation", provider: localRun.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [
        { messageId: "unownedPricing" },
        { messageId: "unownedPricing" },
      ],
    },
    {
      name: "an arbitrary imported run factory is not run provenance",
      code: `
        import { createUnapprovedRunFixture } from "./fake-run-fixture";
        import { seedUsagePricingRows } from "${fixtureModule}";
        const run = await createUnapprovedRunFixture();
        await seedUsagePricingRows([{ kind: "generation", provider: run.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "wrapper returning a fixed lookupProvider remains rejected",
      code: `
        import { upsertUsagePricingRows } from "${fixtureModule}";
        function fakePricing() { return { lookupProvider: "google-maps" }; }
        const fake = fakePricing();
        await upsertUsagePricingRows([{ kind: "generation", provider: fake.lookupProvider, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "mixed fixture-object wrapper calls are fail-closed",
      code: `
        import { createUsagePricingFixture, upsertUsagePricingRows } from "${fixtureModule}";
        function identity(pricing) { return pricing; }
        const fixture = await createUsagePricingFixture({ configured: [{ kind: "generation", provider: "google-maps", category: "maps", unitPrice: 1, unitSize: 1 }] });
        const owned = identity(fixture.resolution[0]);
        identity({ lookupProvider: "google-maps" });
        await upsertUsagePricingRows([{ kind: "generation", provider: owned.lookupProvider, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
    {
      name: "mixed run-object wrapper calls are fail-closed",
      code: `
        import { createUnapprovedRunFixture } from "../../../test-fixtures/agent-runs";
        import { seedUsagePricingRows } from "${fixtureModule}";
        function identity(run) { return run; }
        const fixture = await createUnapprovedRunFixture();
        const owned = identity(fixture);
        identity({ runId: "google-maps" });
        await seedUsagePricingRows([{ kind: "generation", provider: owned.runId, category: "maps", unitPrice: 1, unitSize: 1 }]);
      `,
      errors: [{ messageId: "unownedPricing" }],
    },
  ],
});
