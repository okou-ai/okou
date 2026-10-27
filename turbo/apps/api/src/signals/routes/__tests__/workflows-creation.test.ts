import { randomUUID } from "node:crypto";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}
function collection(signal = context.signal, rethrowErrors = false) {
  return setupApp({ context, routes: workflowsRoutes, signal, rethrowErrors })(
    workflowsCollectionContract,
  );
}
function detail() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}
async function fixture() {
  mockEnv("WORKFLOW_ATTACHMENT_CLEANUP_ENABLED", "true");
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Atomic attachment owner",
    visibility: "public",
  });
  const s3 = installWorkflowVolumeS3Fixture(context);
  const body = {
    agentId: agent.agentId,
    name: `atomic-${randomUUID().slice(0, 8)}`,
    instruction: "Read the attached reference",
    files: [{ path: "reference.md", content: "附件" }],
  };
  return { actor, agent, s3, body };
}
async function sweep() {
  mockEnv("CRON_SECRET", "workflow-creation-cleanup");
  await accept(
    setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
      cronProcessBackgroundJobsContract,
    ).process({
      headers: { authorization: "Bearer workflow-creation-cleanup" },
    }),
    [200],
  );
}

test("keeps a Workflow unlisted until its attachment is ready and publishes readable contents", async () => {
  const { actor, s3, body } = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  s3.beforeNextArchiveWrite(async () => {
    entered.resolve();
    await released.promise;
  });
  const pending = collection().create({ headers: headers(actor), body });
  onTestFinished(async () => {
    if (!released.settled()) {
      released.resolve();
    }
    await pending;
  });
  await entered.promise;
  const before = await accept(
    collection().list({ headers: headers(actor) }),
    [200],
  );
  expect(
    before.body.some((workflow) => {
      return workflow.name === body.name;
    }),
  ).toBeFalsy();
  released.resolve();
  const created = await accept(pending, [201]);
  const read = await accept(
    detail().get({
      headers: headers(actor),
      params: { workflowId: created.body.id },
    }),
    [200],
  );
  expect(read.body).toMatchObject({
    instruction: body.instruction,
    fileContents: body.files,
  });
});

test("publishes one readable Workflow for duplicate creates and durably cleans only the losing candidate", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, s3, body } = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  let losingKey = "";
  s3.beforeNextArchiveWrite(async (key) => {
    losingKey = key;
    entered.resolve();
    await released.promise;
  });
  const first = collection().create({ headers: headers(actor), body });
  onTestFinished(async () => {
    if (!released.settled()) {
      released.resolve();
    }
    await first;
  });
  await entered.promise;
  const winner = await accept(
    collection().create({ headers: headers(actor), body }),
    [201],
  );
  released.resolve();
  await accept(first, [409]);
  await sweep();
  expect(s3.objects.has(losingKey)).toBeFalsy();
  const read = await accept(
    detail().get({
      headers: headers(actor),
      params: { workflowId: winner.body.id },
    }),
    [200],
  );
  expect(read.body.fileContents).toStrictEqual(body.files);
});

test("leaves an aborted upload durably cleanable with a new owner signal and keeps the name available", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, s3, body } = await fixture();
  const controller = new AbortController();
  onTestFinished(() => {
    return controller.abort();
  });
  let key = "";
  s3.afterNextArchiveWrite((objectKey) => {
    key = objectKey;
    controller.abort();
  });
  await expect(
    collection(controller.signal, true).create({
      headers: headers(actor),
      body,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(s3.objects.has(key)).toBeTruthy();
  await sweep();
  expect(s3.objects.has(key)).toBeFalsy();
  const created = await accept(
    collection().create({ headers: headers(actor), body }),
    [201],
  );
  const read = await accept(
    detail().get({
      headers: headers(actor),
      params: { workflowId: created.body.id },
    }),
    [200],
  );
  expect(read.body.fileContents).toStrictEqual(body.files);
});

test("preserves the original upload error and another Workflow's files", async () => {
  const { actor, s3, body } = await fixture();
  const existing = await accept(
    collection().create({ headers: headers(actor), body }),
    [201],
  );
  s3.beforeNextArchiveWrite(() => {
    throw new Error("Original provider upload failure");
  });
  await expect(
    collection(context.signal, true).create({
      headers: headers(actor),
      body: { ...body, name: `failed-${randomUUID().slice(0, 8)}` },
    }),
  ).rejects.toThrow("Original provider upload failure");
  const read = await accept(
    detail().get({
      headers: headers(actor),
      params: { workflowId: existing.body.id },
    }),
    [200],
  );
  expect(read.body.fileContents).toStrictEqual(body.files);
});

test("does not reserve a Workflow name when its files conflict with a directory", async () => {
  const { actor, s3, body } = await fixture();
  await expect(
    collection(context.signal, true).create({
      headers: headers(actor),
      body: {
        ...body,
        files: [
          { path: "reference", content: "file" },
          { path: "reference/nested.md", content: "child" },
        ],
      },
    }),
  ).rejects.toThrow("Workflow attachment file conflicts with a directory");
  expect(s3.writes).toHaveLength(0);
  await accept(collection().create({ headers: headers(actor), body }), [201]);
});

test("rejects publication when Agent access is revoked during attachment upload", async () => {
  const { actor, agent, s3, body } = await fixture();
  const creator = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  s3.beforeNextArchiveWrite(async () => {
    entered.resolve();
    await released.promise;
  });
  const pending = collection().create({ headers: headers(creator), body });
  onTestFinished(async () => {
    if (!released.settled()) {
      released.resolve();
    }
    await pending;
  });
  await entered.promise;
  await bdd.updateAgentMetadata(actor, agent.agentId, {
    visibility: "private",
  });
  released.resolve();
  await accept(pending, [403]);

  await bdd.updateAgentMetadata(actor, agent.agentId, { visibility: "public" });
  const listed = await accept(
    collection().list({ headers: headers(creator) }),
    [200],
  );
  expect(
    listed.body.map((workflow) => {
      return workflow.name;
    }),
  ).not.toContain(body.name);
  const created = await accept(
    collection().create({ headers: headers(creator), body }),
    [201],
  );
  const read = await accept(
    detail().get({
      headers: headers(creator),
      params: { workflowId: created.body.id },
    }),
    [200],
  );
  expect(read.body.fileContents).toStrictEqual(body.files);
});

test("cannot resurrect a parent deleted while its attachment upload is in flight", async () => {
  await setupApp({
    context,
    routes: [...workflowsRoutes, ...cronProcessBackgroundJobsRoutes],
    isolatePg: true,
  });
  const { actor, agent, s3, body } = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  let key = "";
  s3.beforeNextArchiveWrite(async (objectKey) => {
    key = objectKey;
    entered.resolve();
    await released.promise;
  });
  const pending = collection().create({ headers: headers(actor), body });
  onTestFinished(async () => {
    if (!released.settled()) {
      released.resolve();
    }
    await pending;
  });
  await entered.promise;
  await bdd.deleteAgent(actor, agent.agentId);
  released.resolve();
  await accept(pending, [404]);
  await sweep();
  expect(s3.objects.has(key)).toBeFalsy();
});
