import { randomUUID } from "node:crypto";

import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { workflowsRoutes } from "../workflows";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function newActor(
  role: Actor["role"] = "org:member",
  orgId = `org_${randomUUID()}`,
): Actor {
  return { userId: `user_${randomUUID()}`, orgId, role };
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return { authorization: "Bearer clerk-session" };
}

function collection() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

async function createWorkflow(
  actor: Actor,
  name: string,
  visibility: "public" | "private",
): Promise<string> {
  const response = await accept(
    collection().create({
      headers: as(actor),
      body: { name, visibility },
    }),
    [201],
  );
  return response.body.id;
}

async function createPublicWorkflows(admin: Actor): Promise<string[]> {
  return [
    await createWorkflow(admin, "first-flow", "public"),
    await createWorkflow(admin, "second-flow", "public"),
    await createWorkflow(admin, "third-flow", "public"),
  ];
}

async function readRecent(actor: Actor) {
  const response = await accept(
    collection().recent({ headers: as(actor) }),
    [200],
  );
  return response.body.workflowIds;
}

async function recordUse(actor: Actor, workflowIds: string[]) {
  const response = await accept(
    collection().recordRecentUse({ headers: as(actor), body: { workflowIds } }),
    [200],
  );
  return response.body.workflowIds;
}

async function importRecent(actor: Actor, workflowIds: string[]) {
  const response = await accept(
    collection().importRecent({ headers: as(actor), body: { workflowIds } }),
    [200],
  );
  return response.body.workflowIds;
}

test("workflow-recency-001 member history distinguishes never synced from synced empty", async () => {
  const admin = newActor("org:admin");
  const member = newActor("org:member", admin.orgId);
  const [first] = await createPublicWorkflows(admin);

  await expect(readRecent(member)).resolves.toBeNull();
  await expect(importRecent(member, [])).resolves.toStrictEqual([]);
  await expect(readRecent(member)).resolves.toStrictEqual([]);
  await expect(importRecent(member, [first!])).resolves.toStrictEqual([]);
  await expect(recordUse(member, [first!])).resolves.toStrictEqual([first]);
});

test("workflow-recency-002 recorded uses move to the front without duplicates or touching model preferences", async () => {
  const admin = newActor("org:admin");
  const member = newActor("org:member", admin.orgId);
  const [first, second, third] = await createPublicWorkflows(admin);
  const preferences = setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
  const saved = await accept(
    preferences.update({
      headers: as(member),
      body: {
        selectedModel: null,
        serviceTier: null,
        selectedImageModel: "gpt-image-2",
      },
    }),
    [200],
  );

  await expect(readRecent(member)).resolves.toBeNull();
  await expect(
    recordUse(member, [first!, second!, first!]),
  ).resolves.toStrictEqual([first, second]);
  await expect(
    recordUse(member, [third!, first!, third!]),
  ).resolves.toStrictEqual([third, first, second]);
  await expect(readRecent(member)).resolves.toStrictEqual([
    third,
    first,
    second,
  ]);

  const after = await accept(preferences.get({ headers: as(member) }), [200]);
  expect(after.body).toMatchObject({
    selectedModel: saved.body.selectedModel,
    serviceTier: saved.body.serviceTier,
    modelSettings: saved.body.modelSettings,
    selectedImageModel: "gpt-image-2",
  });
});

test("workflow-recency-003 legacy import keeps surviving workflows once and only on first sync", async () => {
  const admin = newActor("org:admin");
  const member = newActor("org:member", admin.orgId);
  const [first, second, third] = await createPublicWorkflows(admin);
  await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsDetailContract,
    ).delete({ headers: as(admin), params: { workflowId: second! } }),
    [204],
  );

  await expect(
    importRecent(member, [third!, second!, first!, third!, randomUUID()]),
  ).resolves.toStrictEqual([third, first]);
  await expect(importRecent(member, [first!])).resolves.toStrictEqual([
    third,
    first,
  ]);
  await expect(readRecent(member)).resolves.toStrictEqual([third, first]);
});

test("workflow-recency-007 history is per member and workspace and rechecks access after demotion", async () => {
  const admin = newActor("org:admin");
  const alice = newActor("org:member", admin.orgId);
  const bob = newActor("org:member", admin.orgId);
  const otherAdmin = newActor("org:admin");
  const sharedX = await createWorkflow(admin, "flow-x", "public");
  const alicePrivateX = await createWorkflow(alice, "flow-x", "private");
  const bobPrivate = await createWorkflow(bob, "bob-flow", "private");
  const otherPublic = await createWorkflow(otherAdmin, "other-flow", "public");
  const all = [sharedX, alicePrivateX, bobPrivate, otherPublic];

  await expect(recordUse(alice, all)).resolves.toStrictEqual([
    sharedX,
    alicePrivateX,
  ]);
  const composer = await accept(
    collection().composer({ headers: as(alice), query: {} }),
    [200],
  );
  expect(
    composer.body.filter((workflow) => {
      return workflow.name === "flow-x";
    }),
  ).toStrictEqual([expect.objectContaining({ id: alicePrivateX })]);

  await expect(readRecent(bob)).resolves.toBeNull();
  await expect(importRecent(bob, all)).resolves.toStrictEqual([
    sharedX,
    bobPrivate,
  ]);

  await expect(
    readRecent({ ...alice, orgId: otherAdmin.orgId }),
  ).resolves.toBeNull();
  await expect(readRecent(alice)).resolves.toStrictEqual([
    sharedX,
    alicePrivateX,
  ]);

  await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowVisibilityContract,
    ).demote({ headers: as(admin), params: { workflowId: sharedX } }),
    [200],
  );
  await expect(readRecent(alice)).resolves.toStrictEqual([alicePrivateX]);
  await expect(readRecent(bob)).resolves.toStrictEqual([bobPrivate]);
});
