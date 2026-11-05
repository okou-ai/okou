import { randomUUID } from "node:crypto";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
  workflowAutomationsContract,
} from "@okouai/api-contracts/contracts/workflows";
import { onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const billing = createBillingMediaApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const mocks = createRouteMocks(context);
function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}
function collection() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}
function detail() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}
function visibility() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowVisibilityContract,
  );
}
function automations() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}
async function fixture() {
  const { actor: admin, defaultAgentId } = await workflowBdd.setupWorkflowOrg({
    tier: "team",
  });
  const alice = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  const bob = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  await billing.updateFeatureSwitches(alice, { singleAgent: true });
  await billing.updateFeatureSwitches(bob, { singleAgent: true });
  const s3 = installWorkflowVolumeS3Fixture(context);
  const source = await accept(
    collection().create({
      headers: headers(admin),
      body: {
        agentId: defaultAgentId,
        name: `shared-${randomUUID().slice(0, 8)}`,
        visibility: "public",
        instruction: "Public version one",
        files: [{ path: "reference.md", content: "Shared reference" }],
      },
    }),
    [201],
  );
  return { admin, alice, bob, defaultAgentId, source: source.body, s3 };
}

test("ordinary members create and copy private Workflows without gaining public rights", async () => {
  const { admin, alice, bob, defaultAgentId, source } = await fixture();
  const personal = await accept(
    collection().create({
      headers: headers(alice),
      body: {
        agentId: defaultAgentId,
        name: `personal-${randomUUID().slice(0, 8)}`,
        instruction: "My steps",
      },
    }),
    [201],
  );
  expect(personal.body).toMatchObject({
    ownerUserId: alice.userId,
    visibility: "private",
    canManage: true,
    canPublish: false,
  });
  const copied = await accept(
    detail().copy({
      headers: headers(alice),
      params: { workflowId: source.id },
      body: { toAgentId: defaultAgentId },
    }),
    [201],
  );
  expect(copied.body).toMatchObject({
    ownerUserId: alice.userId,
    visibility: "private",
    canManage: true,
    canPublish: false,
  });
  const readCopy = await accept(
    detail().get({
      headers: headers(alice),
      params: { workflowId: copied.body.id },
    }),
    [200],
  );
  expect(readCopy.body).toMatchObject({
    instruction: "Public version one",
    fileContents: [{ path: "reference.md", content: "Shared reference" }],
  });
  await accept(
    detail().update({
      headers: headers(alice),
      params: { workflowId: copied.body.id },
      body: { instruction: "Alice's override" },
    }),
    [200],
  );
  await accept(
    detail().copy({
      headers: headers(alice),
      params: { workflowId: source.id },
      body: { toAgentId: defaultAgentId },
    }),
    [409],
  );
  await accept(
    collection().create({
      headers: headers(alice),
      body: {
        agentId: defaultAgentId,
        name: `denied-${randomUUID().slice(0, 8)}`,
        visibility: "public",
      },
    }),
    [403],
  );
  await accept(
    visibility().publish({
      headers: headers(alice),
      params: { workflowId: copied.body.id },
    }),
    [403],
  );
  await accept(
    detail().update({
      headers: headers(alice),
      params: { workflowId: source.id },
      body: { instruction: "Unauthorized public edit" },
    }),
    [403],
  );
  await accept(
    detail().delete({
      headers: headers(alice),
      params: { workflowId: source.id },
    }),
    [403],
  );
  await accept(
    detail().update({
      headers: headers(admin),
      params: { workflowId: source.id },
      body: { instruction: "Latest public definition" },
    }),
    [200],
  );
  await accept(
    visibility().publish({
      headers: headers({ ...alice, orgRole: "org:admin" }),
      params: { workflowId: copied.body.id },
    }),
    [409],
  );
  const aliceCommands = await accept(
    collection().composer({
      headers: headers(alice),
      query: { agentId: defaultAgentId },
    }),
    [200],
  );
  expect(aliceCommands.body.find((row) => row.name === source.name)?.id).toBe(
    copied.body.id,
  );
  const bobCommands = await accept(
    collection().composer({
      headers: headers(bob),
      query: { agentId: defaultAgentId },
    }),
    [200],
  );
  expect(bobCommands.body.find((row) => row.name === source.name)?.id).toBe(
    source.id,
  );
  const aliceList = await accept(
    collection().list({ headers: headers(alice) }),
    [200],
  );
  expect(
    aliceList.body.find((row) => {
      return row.id === source.id;
    })?.shadowedBy?.id,
  ).toBe(copied.body.id);
  const bobList = await accept(
    collection().list({ headers: headers(bob) }),
    [200],
  );
  expect(
    bobList.body.find((row) => {
      return row.id === source.id;
    })?.shadowedBy,
  ).toBeNull();
  const shared = await accept(
    detail().get({ headers: headers(bob), params: { workflowId: source.id } }),
    [200],
  );
  expect(shared.body.instruction).toBe("Latest public definition");
  const retained = await accept(
    detail().get({
      headers: headers(alice),
      params: { workflowId: copied.body.id },
    }),
    [200],
  );
  expect(retained.body.instruction).toBe("Alice's override");
  await accept(
    detail().get({
      headers: headers(bob),
      params: { workflowId: copied.body.id },
    }),
    [404],
  );
  const chat = await accept(
    detail().chatThread({
      headers: headers(alice),
      params: { workflowId: source.id },
    }),
    [200],
  );
  expect(chat.body.prompt).toContain(source.id);
});

test("copies only the caller's Automations and preserves the existing private copy", async () => {
  const { admin, alice, defaultAgentId, source } = await fixture();
  for (const actor of [admin, alice]) {
    await accept(
      automations().create({
        headers: headers(actor),
        params: { workflowId: source.id },
        body: {
          kind: "schedule",
          schedule: {
            type: "loop",
            intervalSeconds: actor === alice ? 900 : 1800,
          },
        },
      }),
      [201],
    );
  }
  const copied = await accept(
    detail().copy({
      headers: headers(alice),
      params: { workflowId: source.id },
      body: { toAgentId: defaultAgentId },
    }),
    [201],
  );
  const copiedAutomations = await accept(
    automations().list({
      headers: headers(alice),
      params: { workflowId: copied.body.id },
    }),
    [200],
  );
  expect(copiedAutomations.body).toHaveLength(1);
  expect(copiedAutomations.body[0]).toMatchObject({
    ownerUserId: alice.userId,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 900 },
  });
});

test("keeps default-namespace listing gated and does not widen legacy private copy admission", async () => {
  const { admin, alice, defaultAgentId, source } = await fixture();
  const other = await bdd.createAgent(admin, {
    displayName: "Retained legacy agent",
    visibility: "public",
  });
  const legacy = await accept(
    collection().create({
      headers: headers(admin),
      body: {
        agentId: other.agentId,
        name: `legacy-${randomUUID().slice(0, 8)}`,
      },
    }),
    [201],
  );
  const enabled = await accept(
    collection().list({
      headers: headers(alice),
      query: { agentId: other.agentId },
    }),
    [200],
  );
  expect(
    enabled.body.every((row) => {
      return row.agentId === defaultAgentId;
    }),
  ).toBeTruthy();
  await accept(
    detail().copy({
      headers: headers(alice),
      params: { workflowId: source.id },
      body: { toAgentId: other.agentId },
    }),
    [403],
  );
  await billing.updateFeatureSwitches(alice, { singleAgent: false });
  await accept(
    detail().copy({
      headers: headers(alice),
      params: { workflowId: source.id },
      body: { toAgentId: defaultAgentId },
    }),
    [403],
  );
  const disabled = await accept(
    collection().list({ headers: headers(admin) }),
    [200],
  );
  expect(
    disabled.body.some((row) => {
      return row.id === legacy.body.id;
    }),
  ).toBeTruthy();
});

test("rejects a member copy if its default target changes during publication", async () => {
  const { admin, alice, defaultAgentId, source, s3 } = await fixture();
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  s3.beforeNextArchiveWrite(async () => {
    entered.resolve();
    await released.promise;
  });
  const copying = detail().copy({
    headers: headers(alice),
    params: { workflowId: source.id },
    body: { toAgentId: defaultAgentId },
  });
  onTestFinished(async () => {
    if (!released.settled()) {
      released.resolve();
    }
    await copying;
  });
  await entered.promise;
  await bdd.updateAgent(admin, defaultAgentId, {
    description: "Updated default executor",
  });
  released.resolve();
  await accept(copying, [409]);
  const visible = await accept(
    collection().list({ headers: headers(alice) }),
    [200],
  );
  expect(
    visible.body.filter((row) => {
      return row.name === source.name && row.visibility === "private";
    }),
  ).toStrictEqual([]);
});
