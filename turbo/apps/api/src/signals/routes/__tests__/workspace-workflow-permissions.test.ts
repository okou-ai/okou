import { randomUUID } from "node:crypto";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [...workflowsRoutes, ...workflowAutomationsRoutes],
});

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function as(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return headers;
}

async function schedule(actor: Actor, workflowId: string, seconds: number) {
  await accept(
    app(workflowAutomationsContract).create({
      headers: as(actor),
      params: { workflowId },
      body: { schedule: { type: "loop", intervalSeconds: seconds } },
    }),
    [201],
  );
}

test("workspace-workflow-permissions-002 copies only the caller's Automations", async () => {
  const orgId = `org_${randomUUID()}`;
  const admin: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:admin",
  };
  const member: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:member",
  };
  const source = await accept(
    app(workflowsCollectionContract).create({
      headers: as(admin),
      body: {
        name: `shared-${randomUUID().slice(0, 8)}`,
        visibility: "public",
      },
    }),
    [201],
  );
  await schedule(admin, source.body.id, 1800);
  await schedule(member, source.body.id, 900);

  const copy = await accept(
    app(workflowsDetailContract).copy({
      headers: as(member),
      params: { workflowId: source.body.id },
      body: {},
    }),
    [201],
  );
  const automations = await accept(
    app(workflowAutomationsContract).list({
      headers: as(member),
      params: { workflowId: copy.body.id },
    }),
    [200],
  );

  expect(automations.body).toHaveLength(1);
  expect(automations.body[0]).toMatchObject({
    ownerUserId: member.userId,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 900 },
  });
});

/** A Team administrator's public Workflow with a reference file and two members. */
async function teamWithPublicWorkflow() {
  installWorkflowVolumeS3Fixture(context);
  const orgId = `org_${randomUUID()}`;
  const admin: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:admin",
  };
  const alice: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:member",
  };
  const bob: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:member",
  };
  const files = [{ path: "reference.md", content: "Team reference" }];
  const name = `team-${randomUUID().slice(0, 8)}`;
  const source = await accept(
    app(workflowsCollectionContract).create({
      headers: as(admin),
      body: {
        name,
        instruction: "Team instruction",
        files,
        visibility: "public",
      },
    }),
    [201],
  );
  return { admin, alice, bob, files, name, sourceId: source.body.id };
}

function copyWorkflow(actor: Actor, workflowId: string) {
  return app(workflowsDetailContract).copy({
    headers: as(actor),
    params: { workflowId },
    body: {},
  });
}

/** Alice's private copy of the public Workflow, edited with her override. */
async function aliceOverrideCopy(alice: Actor, sourceId: string) {
  const copy = await accept(copyWorkflow(alice, sourceId), [201]);
  await accept(
    app(workflowsDetailContract).update({
      headers: as(alice),
      params: { workflowId: copy.body.id },
      body: { instruction: "Alice override" },
    }),
    [200],
  );
  return copy.body.id;
}

test("workspace-workflow-permissions-001 (1/4) lets a member create and copy private Workflows she manages", async () => {
  const { alice, files, sourceId } = await teamWithPublicWorkflow();
  const collection = app(workflowsCollectionContract);
  const detail = app(workflowsDetailContract);

  const own = await accept(
    collection.create({
      headers: as(alice),
      body: { name: `alice-${randomUUID().slice(0, 8)}` },
    }),
    [201],
  );
  const copy = await accept(copyWorkflow(alice, sourceId), [201]);
  for (const created of [own.body, copy.body]) {
    expect(created).toMatchObject({
      visibility: "private",
      ownerUserId: alice.userId,
      canManage: true,
      canPublish: false,
    });
  }
  const copyId = copy.body.id;
  const copied = await accept(
    detail.get({ headers: as(alice), params: { workflowId: copyId } }),
    [200],
  );
  expect(copied.body.instruction).toBe("Team instruction");
  expect(copied.body.fileContents).toStrictEqual(files);
  await accept(
    detail.update({
      headers: as(alice),
      params: { workflowId: copyId },
      body: { instruction: "Alice override" },
    }),
    [200],
  );
  await accept(copyWorkflow(alice, sourceId), [409]);
});

test("workspace-workflow-permissions-001 (2/4) forbids a member's public creation and publication", async () => {
  const { alice, sourceId } = await teamWithPublicWorkflow();
  const copyId = await aliceOverrideCopy(alice, sourceId);

  const publicCreation = await app(workflowsCollectionContract).create({
    headers: as(alice),
    body: {
      name: `public-${randomUUID().slice(0, 8)}`,
      visibility: "public",
    },
  });
  const memberPublish = await app(workflowVisibilityContract).publish({
    headers: as(alice),
    params: { workflowId: copyId },
  });

  expect([publicCreation.status, memberPublish.status]).toStrictEqual([
    403, 403,
  ]);
});

test("workspace-workflow-permissions-001 (3/4) keeps the source out of a member's reach and conflicts on publishing the copy as admin", async () => {
  const { alice, sourceId } = await teamWithPublicWorkflow();
  const copyId = await aliceOverrideCopy(alice, sourceId);
  const detail = app(workflowsDetailContract);

  const sourceEdit = await detail.update({
    headers: as(alice),
    params: { workflowId: sourceId },
    body: { instruction: "Hijacked" },
  });
  const sourceDelete = await detail.delete({
    headers: as(alice),
    params: { workflowId: sourceId },
  });
  const adminPublish = await app(workflowVisibilityContract).publish({
    headers: as({ ...alice, role: "org:admin" }),
    params: { workflowId: copyId },
  });

  expect([
    sourceEdit.status,
    sourceDelete.status,
    adminPublish.status,
  ]).toStrictEqual([403, 403, 409]);
});

test("workspace-workflow-permissions-001 (4/4) resolves Alice's copy for her and the updated public Workflow for Bob", async () => {
  const { admin, alice, bob, name, sourceId } = await teamWithPublicWorkflow();
  const copyId = await aliceOverrideCopy(alice, sourceId);
  const collection = app(workflowsCollectionContract);
  const detail = app(workflowsDetailContract);
  await accept(
    detail.update({
      headers: as(admin),
      params: { workflowId: sourceId },
      body: { instruction: "Team instruction v2" },
    }),
    [200],
  );

  const aliceComposer = await accept(
    collection.composer({ headers: as(alice) }),
    [200],
  );
  const aliceList = await accept(
    collection.list({ headers: as(alice), query: {} }),
    [200],
  );
  const aliceCopy = await accept(
    detail.get({ headers: as(alice), params: { workflowId: copyId } }),
    [200],
  );
  const bobComposer = await accept(
    collection.composer({ headers: as(bob) }),
    [200],
  );
  const bobList = await accept(
    collection.list({ headers: as(bob), query: {} }),
    [200],
  );
  const bobSource = await accept(
    detail.get({ headers: as(bob), params: { workflowId: sourceId } }),
    [200],
  );
  await accept(
    detail.get({ headers: as(bob), params: { workflowId: copyId } }),
    [404],
  );
  const chat = await accept(
    detail.chatThread({ headers: as(bob), params: { workflowId: sourceId } }),
    [200],
  );

  const idsNamed = (entries: readonly { id: string; name: string }[]) => {
    return entries
      .filter((entry) => {
        return entry.name === name;
      })
      .map((entry) => {
        return entry.id;
      });
  };
  expect(idsNamed(aliceComposer.body)).toStrictEqual([copyId]);
  expect(idsNamed(aliceList.body)).toContain(copyId);
  expect(aliceCopy.body.instruction).toBe("Alice override");
  expect(idsNamed(bobComposer.body)).toStrictEqual([sourceId]);
  expect(idsNamed(bobList.body)).toStrictEqual([sourceId]);
  expect(bobSource.body.instruction).toBe("Team instruction v2");
  expect(chat.body.prompt).toContain(sourceId);
});
