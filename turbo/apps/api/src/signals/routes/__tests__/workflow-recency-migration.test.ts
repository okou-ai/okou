import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const wf = createWorkflowsBddApi(context);
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);
const BINGJIE_USER_ID = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";

function headers(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function detailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function preferenceClient() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}

async function setup() {
  // The rollout's real allowed identity, with a unique workspace per case.
  // Agent/workflow creation does not initialize this member's model preferences.
  const actor = wf.user({ userId: BINGJIE_USER_ID });
  const { agentId } = await wf.createAgent(actor);
  return { actor, agentId };
}

async function composer(actor: ApiTestUser, agentId: string) {
  return (
    await accept(
      client().composer({ headers: headers(actor), query: { agentId } }),
      [200],
    )
  ).body;
}

async function migrate(actor: ApiTestUser, workflowIds: readonly string[]) {
  return await accept(
    client().migrateRecency({
      headers: headers(actor),
      body: { workflowIds: [...workflowIds] },
    }),
    [200],
  );
}

function marker(index: number) {
  return `1970-01-01T00:00:00.${String(10 - index).padStart(6, "0")}Z`;
}

describe("POST /api/workflows/recency/migrate", () => {
  it("imports into an absent member preference row and exposes only relative legacy order", async () => {
    const { actor, agentId } = await setup();
    const first = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-zulu",
    });
    const second = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-alpha",
    });
    const before = await accept(
      preferenceClient().get({ headers: headers(actor) }),
      [200],
    );
    expect(before.body).toMatchObject({ selectedModel: null, updatedAt: null });
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    expect((await migrate(actor, [])).body).toStrictEqual({ migrated: false });
    expect((await migrate(actor, [randomUUID()])).body).toStrictEqual({
      migrated: false,
    });
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // The request may contain the full 1000-item localStorage history. UUID
    // canonicalization and deduplication precede the valid top-ten selection.
    const ids = [
      first.toUpperCase(),
      first,
      second,
      ...Array.from({ length: 997 }, () => {
        return randomUUID();
      }),
    ];
    expect((await migrate(actor, ids)).body).toStrictEqual({ migrated: true });
    await expect(composer(actor, agentId)).resolves.toStrictEqual([
      expect.objectContaining({ id: second, lastUsedAt: marker(1) }),
      expect.objectContaining({ id: first, lastUsedAt: marker(0) }),
    ]);
    const after = await accept(
      preferenceClient().get({ headers: headers(actor) }),
      [200],
    );
    expect(after.body).toMatchObject({
      selectedModel: "auto",
      serviceTier: null,
      modelSettings: {},
      selectedImageModel: null,
    });
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["workflowRecency"] },
    );
  });

  it("imports empty history across agents without changing existing model preferences", async () => {
    const { actor, agentId } = await setup();
    const { agentId: secondAgentId } = await wf.createAgent(actor);
    const first = await wf.createWorkflow(actor, {
      agentId: secondAgentId,
      name: "legacy-first",
    });
    const second = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-second",
    });
    const before = await accept(
      preferenceClient().update({
        headers: headers(actor),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "gpt-image-2",
        },
      }),
      [200],
    );
    expect((await migrate(actor, [first, second])).body).toStrictEqual({
      migrated: true,
    });
    await expect(composer(actor, secondAgentId)).resolves.toContainEqual(
      expect.objectContaining({ id: first, lastUsedAt: marker(0) }),
    );
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: second, lastUsedAt: marker(1) }),
    );
    const after = await accept(
      preferenceClient().get({ headers: headers(actor) }),
      [200],
    );
    expect(after.body).toStrictEqual(before.body);
  });

  it("accepts only one concurrent import and leaves nonempty history unchanged on replay", async () => {
    const { actor, agentId } = await setup();
    const first = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-one",
    });
    const second = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-two",
    });
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    const imports = await Promise.all([
      migrate(actor, [first, second]),
      migrate(actor, [second, first]),
    ]);
    expect(
      imports
        .map((result) => {
          return result.body.migrated;
        })
        .sort(),
    ).toStrictEqual([false, true]);
    const winnerIds = imports[0]?.body.migrated
      ? [first, second]
      : [second, first];
    const imported = await composer(actor, agentId);
    for (const [index, id] of winnerIds.entries()) {
      expect(imported).toContainEqual(
        expect.objectContaining({ id, lastUsedAt: marker(index) }),
      );
    }
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    context.mocks.ably.publish.mockClear();
    expect((await migrate(actor, [second])).body).toStrictEqual({
      migrated: false,
    });
    await expect(composer(actor, agentId)).resolves.toStrictEqual(imported);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("filters inaccessible, deleted, foreign-workspace and shadowed IDs before choosing ten unique workflows", async () => {
    const { actor, agentId } = await setup();
    const peer = wf.user({ orgId: actor.orgId, orgRole: "org:admin" });
    const peerPrivate = await wf.createWorkflow(peer, {
      agentId,
      name: "legacy-peer-private",
      visibility: "private",
    });
    const peerPublic = await wf.createWorkflow(peer, {
      agentId,
      name: "legacy-peer-public",
      visibility: "public",
    });
    const { agentId: hiddenAgentId } = await wf.createAgent(peer, {
      visibility: "private",
    });
    const hiddenPublic = await wf.createWorkflow(peer, {
      agentId: hiddenAgentId,
      name: "legacy-hidden-agent",
      visibility: "public",
    });
    const foreign = wf.user({ userId: BINGJIE_USER_ID });
    const { agentId: foreignAgentId } = await wf.createAgent(foreign);
    const foreignId = await wf.createWorkflow(foreign, {
      agentId: foreignAgentId,
      name: "legacy-other-workspace",
    });
    const deleted = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-deleted",
    });
    await accept(
      detailClient().delete({
        headers: headers(actor),
        params: { workflowId: deleted },
      }),
      [204],
    );
    const shadowed = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-shadow",
      visibility: "public",
    });
    const privateWinner = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-shadow",
      visibility: "private",
    });
    const valid = [peerPublic, privateWinner];
    for (let index = 0; index < 10; index += 1) {
      valid.push(
        await wf.createWorkflow(actor, {
          agentId,
          name: `legacy-valid-${index}`,
        }),
      );
    }
    const ignored = [
      ...Array.from({ length: 12 }, () => {
        return randomUUID();
      }),
      peerPrivate,
      hiddenPublic,
      foreignId,
      deleted,
      shadowed,
    ];
    const supplied = [
      ...ignored,
      ...valid.flatMap((id) => {
        return [id, id.toUpperCase()];
      }),
    ];
    expect((await migrate(actor, supplied)).body).toStrictEqual({
      migrated: true,
    });
    const imported = (await composer(actor, agentId)).filter((workflow) => {
      return workflow.lastUsedAt !== null;
    });
    expect(imported).toHaveLength(10);
    for (const [index, id] of valid.slice(0, 10).entries()) {
      expect(imported).toContainEqual(
        expect.objectContaining({ id, lastUsedAt: marker(index) }),
      );
    }
    await expect(composer(foreign, foreignAgentId)).resolves.toContainEqual(
      expect.objectContaining({ id: foreignId, lastUsedAt: null }),
    );
    await expect(composer(peer, agentId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: peerPrivate, lastUsedAt: null }),
        expect.objectContaining({ id: peerPublic, lastUsedAt: null }),
      ]),
    );
  });

  it("rejects the entire malformed or oversized request instead of partially importing valid IDs", async () => {
    const { actor, agentId } = await setup();
    const workflowId = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-validation",
    });
    const invalidBodies = [
      { workflowIds: [workflowId, "not-a-workflow-uuid"] },
      {
        workflowIds: Array.from({ length: 1001 }, () => {
          return randomUUID();
        }),
      },
      {
        workflowIds: [workflowId],
        userId: BINGJIE_USER_ID,
        orgId: actor.orgId,
        lastUsedAt: "2030-01-01T00:00:00.000Z",
      },
    ];
    for (const body of invalidBodies) {
      const response = await createApp({
        signal: context.signal,
        routes: workflowsRoutes,
      }).request("/api/workflows/recency/migrate", {
        method: "POST",
        headers: { ...headers(actor), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: null }),
    );
    expect((await migrate(actor, [workflowId])).body).toStrictEqual({
      migrated: true,
    });
  });

  it("requires an authenticated workspace session and denies a default-off member", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await client().migrateRecency({
      headers: {},
      body: { workflowIds: [] },
    });
    expect(anonymous.status).toBe(401);
    const noWorkspace = await client().migrateRecency({
      headers: headers(wf.user({ userId: BINGJIE_USER_ID, orgId: null })),
      body: { workflowIds: [] },
    });
    expect(noWorkspace.status).toBe(401);
    const outsideRollout = await client().migrateRecency({
      headers: headers(wf.user()),
      body: { workflowIds: [] },
    });
    expect(outsideRollout.status).toBe(403);
  });

  it("never imports a visible Official Workflow", async () => {
    // Publishing the shared Official catalog is an explicit operator boundary;
    // isolate that global publication before constructing the user's resources.
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronOfficialWorkflowCatalogRoutes,
        ...morningBriefPreferenceRoutes,
      ],
    });
    const actor = wf.user({ userId: BINGJIE_USER_ID });
    await runs.grantProEntitlement(actor);
    await bdd.updateUserTimezone(actor, "UTC");
    installWorkflowVolumeS3Fixture(context);
    const published = await accept(
      app(cronOfficialWorkflowCatalogContract).sync({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
    expect(published.body.outcome).toBe("accepted");
    const enabled = await accept(
      app(morningBriefPreferenceContract).update({
        headers: headers(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(enabled.body.status).toBe("enabled");
    const listed = await accept(
      client().list({ headers: headers(actor), query: {} }),
      [200],
    );
    const official = listed.body.find((workflow) => {
      return workflow.official !== null;
    });
    if (!official) {
      throw new Error("Expected a publicly installed Official Workflow");
    }
    expect((await migrate(actor, [official.id])).body).toStrictEqual({
      migrated: false,
    });
    const { agentId } = await wf.createAgent(actor);
    const workflowId = await wf.createWorkflow(actor, {
      agentId,
      name: "legacy-ordinary",
    });
    expect(
      (await migrate(actor, [official.id, workflowId])).body,
    ).toStrictEqual({ migrated: true });
    await expect(composer(actor, agentId)).resolves.toContainEqual(
      expect.objectContaining({ id: workflowId, lastUsedAt: marker(0) }),
    );
  });
});
