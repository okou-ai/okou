import { randomUUID } from "node:crypto";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { onTestFinished, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const misc = createMiscRoutesApi(context);
const mocks = createRouteMocks(context);

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

test("rejects a prepared copy after the source Workflow changes", async () => {
  const actor = bdd.user();
  bdd.acceptStorageWrites();
  await bdd.bootstrapLimitedFreeOnboarding(actor);
  const copier = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  const s3 = installWorkflowVolumeS3Fixture(context);
  const name = `changed-copy-${randomUUID().slice(0, 8)}`;
  const workflow = await misc.createWorkflow(
    actor,
    name,
    {
      visibility: "public",
      content: "# Before preparation",
      files: [{ path: "notes.md", content: "Prepared file" }],
    },
    [201],
  );
  const copyHeaders = headers(copier);
  if (workflow.status !== 201) {
    throw new Error("Expected the source Workflow to be created");
  }
  const signal = AbortSignal.timeout(10_000);
  const entered = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  s3.beforeNextArchiveWrite(async () => {
    entered.resolve();
    await released.promise;
  });
  const copying = accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsDetailContract,
    ).copy({
      headers: copyHeaders,
      params: { workflowId: workflow.body.id },
      body: {},
    }),
    [409],
  );
  let uploadReleased = false;
  onTestFinished(async () => {
    if (!uploadReleased) {
      released.resolve();
    }
    await copying;
  });
  await entered.promise;
  await misc.updateWorkflow(
    actor,
    workflow.body.id,
    "# Changed during preparation",
    [200],
  );
  uploadReleased = true;
  released.resolve();
  expect((await copying).body.error.code).toBe("CONFLICT");
  const listed = await misc.listWorkflows(copier);
  expect(
    listed.body.filter((row) => {
      return row.visibility === "private" && row.name === name;
    }),
  ).toStrictEqual([]);
  const current = await accept(
    setupApp({ context, routes: workflowsRoutes })(workflowsDetailContract).get(
      {
        headers: headers(actor),
        params: { workflowId: workflow.body.id },
      },
    ),
    [200],
  );
  expect(current.body.instruction).toBe("# Changed during preparation");
});

test("rejects a prepared member copy after its public source is deleted", async () => {
  const admin = bdd.user({ orgRole: "org:admin" });
  const owner = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  bdd.acceptStorageWrites();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  const s3 = installWorkflowVolumeS3Fixture(context);
  const name = `revoked-copy-${randomUUID().slice(0, 8)}`;
  const workflow = await misc.createWorkflow(
    admin,
    name,
    {
      visibility: "public",
      content: "# Permission checked before upload",
      files: [{ path: "notes.md", content: "Prepared file" }],
    },
    [201],
  );
  const copyHeaders = headers(owner);
  if (workflow.status !== 201) {
    throw new Error("Expected the source Workflow to be created");
  }
  const signal = AbortSignal.timeout(10_000);
  const entered = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  s3.beforeNextArchiveWrite(async () => {
    entered.resolve();
    await released.promise;
  });
  const copying = accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsDetailContract,
    ).copy({
      headers: copyHeaders,
      params: { workflowId: workflow.body.id },
      body: {},
    }),
    [409],
  );
  let uploadReleased = false;
  onTestFinished(async () => {
    if (!uploadReleased) {
      released.resolve();
    }
    await copying;
  });
  await entered.promise;
  await misc.deleteWorkflow(admin, workflow.body.id, [204]);
  uploadReleased = true;
  released.resolve();
  expect((await copying).body.error.code).toBe("CONFLICT");
  const listed = await misc.listWorkflows(owner);
  expect(
    listed.body.filter((row) => {
      return row.visibility === "private" && row.name === name;
    }),
  ).toStrictEqual([]);
});
