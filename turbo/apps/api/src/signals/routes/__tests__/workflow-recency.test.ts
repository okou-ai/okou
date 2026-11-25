import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { workflowsRoutes } from "../workflows";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const mocks = createRouteMocks(context);

function member(
  orgId = `org_${randomUUID()}`,
  orgRole: "org:admin" | "org:member" = "org:member",
) {
  return { userId: `user_${randomUUID()}`, orgId, orgRole };
}
type Member = ReturnType<typeof member>;

function headers(actor: Member) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}
function collection() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}
async function read(actor: Member) {
  return (await accept(collection().recent({ headers: headers(actor) }), [200]))
    .body.workflowIds;
}
async function use(actor: Member, workflowIds: string[]) {
  return (
    await accept(
      collection().recordRecentUse({
        headers: headers(actor),
        body: { workflowIds },
      }),
      [200],
    )
  ).body.workflowIds;
}
async function importRecent(actor: Member, workflowIds: string[]) {
  return (
    await accept(
      collection().importRecent({
        headers: headers(actor),
        body: { workflowIds },
      }),
      [200],
    )
  ).body.workflowIds;
}
async function createWorkflow(
  actor: Member,
  visibility: "public" | "private" = "public",
  name = `recent-${randomUUID().slice(0, 8)}`,
) {
  return (
    await accept(
      collection().create({
        headers: headers(actor),
        body: { name, visibility, instruction: "Follow these steps" },
      }),
      [201],
    )
  ).body.id;
}
async function fixture() {
  installWorkflowVolumeS3Fixture(context);
  const owner = member(undefined, "org:admin");
  const actor = member(owner.orgId);
  const first = await createWorkflow(owner);
  const second = await createWorkflow(owner);
  const third = await createWorkflow(owner);
  return { owner, actor, first, second, third };
}

describe("workspace member workflow recency", () => {
  it("distinguishes an uninitialized history from an initialized empty history", async () => {
    const { actor, first } = await fixture();
    await expect(read(actor)).resolves.toBeNull();
    await expect(importRecent(actor, [])).resolves.toStrictEqual([]);
    await expect(read(actor)).resolves.toStrictEqual([]);
    await expect(importRecent(actor, [first])).resolves.toStrictEqual([]);
    await expect(use(actor, [first])).resolves.toStrictEqual([first]);
  });

  it("moves all used IDs to the front in order without duplicating IDs or changing model preferences", async () => {
    const { actor, first, second, third } = await fixture();
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const saved = await accept(
      preferences.update({
        headers: headers(actor),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "gpt-image-2",
        },
      }),
      [200],
    );
    await expect(read(actor)).resolves.toBeNull();
    await expect(use(actor, [first, second, first])).resolves.toStrictEqual([
      first,
      second,
    ]);
    await expect(use(actor, [third, first, third])).resolves.toStrictEqual([
      third,
      first,
      second,
    ]);
    await expect(read(actor)).resolves.toStrictEqual([third, first, second]);
    const retained = await accept(
      preferences.get({ headers: headers(actor) }),
      [200],
    );
    expect(retained.body).toMatchObject({
      selectedModel: saved.body.selectedModel,
      serviceTier: saved.body.serviceTier,
      modelSettings: saved.body.modelSettings,
      selectedImageModel: "gpt-image-2",
    });
  });

  it("imports surviving IDs once in their original order and returns the server history on later imports", async () => {
    const { owner, actor, first, second, third } = await fixture();
    await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsDetailContract,
      ).delete({
        headers: headers(owner),
        params: { workflowId: second },
      }),
      [204],
    );
    await expect(
      importRecent(actor, [third, second, first, third, randomUUID()]),
    ).resolves.toStrictEqual([third, first]);
    await expect(importRecent(actor, [first])).resolves.toStrictEqual([
      third,
      first,
    ]);
    await expect(read(actor)).resolves.toStrictEqual([third, first]);
  });

  it("merges concurrent uses without losing either record when member metadata does not yet exist", async () => {
    const { actor, first, second, third } = await fixture();
    await expect(read(actor)).resolves.toBeNull();
    const results = await Promise.all([
      use(actor, [first, second]),
      use(actor, [third, first]),
    ]);
    const final = await read(actor);
    expect(final).not.toBeNull();
    expect(new Set(final)).toStrictEqual(new Set([first, second, third]));
    expect(final).toHaveLength(3);
    expect(results).toContainEqual(final);
  });

  it("keeps a concurrent use whether the import wins initialization or arrives too late", async () => {
    const { actor, first, second, third } = await fixture();
    const [imported] = await Promise.all([
      importRecent(actor, [second, third]),
      use(actor, [first]),
    ]);
    await expect(read(actor)).resolves.toStrictEqual(
      imported.includes(second) ? [first, second, third] : [first],
    );
  });

  it("returns one canonical winner to both concurrent importers", async () => {
    const { actor, first, second, third } = await fixture();
    const histories = [
      [second, first],
      [third, second],
    ];
    const [left, right] = await Promise.all([
      importRecent(actor, [second, first]),
      importRecent(actor, [third, second]),
    ]);
    expect(histories).toContainEqual(left);
    expect(right).toStrictEqual(left);
    await expect(read(actor)).resolves.toStrictEqual(left);
  });

  it("isolates members and workspaces while retaining visible public shadows and rechecking revoked access", async () => {
    installWorkflowVolumeS3Fixture(context);
    const owner = member(undefined, "org:admin");
    const alice = member(owner.orgId);
    const bob = member(owner.orgId);
    const elsewhere = member(undefined, "org:admin");
    const slug = `shared-${randomUUID().slice(0, 8)}`;
    const shared = await createWorkflow(owner, "public", slug);
    const personal = await createWorkflow(alice, "private", slug);
    const bobsPrivate = await createWorkflow(bob, "private");
    const foreign = await createWorkflow(elsewhere);
    await expect(
      use(alice, [shared, personal, bobsPrivate, foreign]),
    ).resolves.toStrictEqual([shared, personal]);
    const composer = await accept(
      collection().composer({ headers: headers(alice), query: {} }),
      [200],
    );
    expect(
      composer.body
        .filter((workflow) => {
          return workflow.name === slug;
        })
        .map((workflow) => {
          return workflow.id;
        }),
    ).toStrictEqual([personal]);
    await expect(read(bob)).resolves.toBeNull();
    await expect(
      importRecent(bob, [personal, shared, bobsPrivate, foreign]),
    ).resolves.toStrictEqual([shared, bobsPrivate]);
    const aliceElsewhere = { ...elsewhere, userId: alice.userId };
    await expect(read(aliceElsewhere)).resolves.toBeNull();
    await expect(read(alice)).resolves.toStrictEqual([shared, personal]);
    await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowVisibilityContract,
      ).demote({
        headers: headers(owner),
        params: { workflowId: shared },
      }),
      [200],
    );
    await expect(read(alice)).resolves.toStrictEqual([personal]);
    await expect(read(bob)).resolves.toStrictEqual([bobsPrivate]);
  });

  it("requires organization member authentication and returns private, uncached history", async () => {
    const actor = member();
    const api = collection();
    const initial = await accept(
      api.recent({ headers: headers(actor) }),
      [200],
    );
    expect(initial.body.workflowIds).toBeNull();
    expect(initial.headers.get("cache-control")).toBe("private, no-store");
    mocks.clerk.session(actor.userId, null);
    const auth = { authorization: "Bearer clerk-session" };
    await accept(api.recent({ headers: auth }), [401]);
    await accept(
      api.recordRecentUse({ headers: auth, body: { workflowIds: [] } }),
      [401],
    );
    await accept(
      api.importRecent({ headers: auth, body: { workflowIds: [] } }),
      [401],
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await accept(api.recent({}), [401]);
  });
});
