import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { sql } from "drizzle-orm";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  countAgentStableContextPublicationsFixture,
  countUserStableContextGenerationsFixture,
  deleteExpiredOwnedPiStableContextArtifactFixture,
  readAgentInstructionsStorageFixture,
  removePiStableContextHeadFixture,
  seedAgentInstructionsStorageWithIdFixture,
  seedPiStableContextStorageDemandFixture,
  stableContextBackendBlockedByFixture,
} from "../../../test-fixtures/pi-stable-context";
import { holdUserConnectorMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-connectors";
import { holdUserPermissionGrantMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-permission-grants";
import {
  holdChatThreadConnectorSelectionBeforeAgentLockFixture,
  holdChatThreadConnectorSelectionBeforeErasureAdmissionFixture,
  holdClerkAgentLifecycleAfterInstructionsStorageLocksFixture,
  holdWorkflowCopyBeforeErasureAdmissionFixture,
  holdWorkflowCreationBeforeErasureAdmissionFixture,
  holdWorkflowDeleteBeforeErasureAdmissionFixture,
  holdWorkflowUpdateAfterMetadataMutationFixture,
  observeClerkAgentLifecycleBeforeAgentLockFixture,
  holdWorkflowUpdateBeforeErasureAdmissionFixture,
} from "../../../test-fixtures/pi-stable-context-source-writers";
import { agentsRoutes } from "../agents";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { workflowsRoutes } from "../workflows";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const THREAD_MODEL = "claude-sonnet-5";

async function createPublicAgentThread(args: {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly threadUserId: string;
}): Promise<{ readonly agentId: string; readonly chatThreadId: string }> {
  const owner = bdd.user({
    orgId: args.orgId,
    userId: args.ownerUserId,
    orgRole: "org:admin",
  });
  const threadUser = bdd.user({
    orgId: args.orgId,
    userId: args.threadUserId,
    orgRole: "org:member",
  });
  bdd.acceptAgentStorageWrites();
  const { providerId } = await runs.ensureOrgModelProvider(owner);
  await runs.updateOrgModelPolicies(owner, [
    {
      model: THREAD_MODEL,
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(owner, {
    displayName: "Surviving public agent",
    visibility: "public",
  });
  const thread = await chat.createThread(threadUser, {
    agentId: agent.agentId,
    model: THREAD_MODEL,
  });
  return { agentId: agent.agentId, chatThreadId: thread.id };
}

async function deleteUserWithSignedWebhook(
  userId: string,
  secretLabel: string,
  options?: { readonly flush?: boolean },
): Promise<void> {
  const sdk = await vi.importActual<typeof import("@clerk/backend/webhooks")>(
    "@clerk/backend/webhooks",
  );
  const secret = `whsec_${Buffer.from(secretLabel).toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(
    async (request: unknown) => {
      if (!(request instanceof Request)) {
        throw new Error("expected raw Request");
      }
      return await sdk.verifyWebhook(request, { signingSecret: secret });
    },
  );
  const body = JSON.stringify({
    type: "user.deleted",
    data: { id: userId, deleted: true },
  });
  const id = randomUUID();
  const timestamp = nowDate();
  const signature = new Webhook(secret).sign(id, timestamp, body);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
    }),
    [200],
  );
  if (options?.flush !== false) {
    await flushWaitUntilForTest();
  }
}

test("keeps the current signed Clerk deletion ACK and preserves another owner's agent without bridge configuration", async () => {
  // Execute the actual SDK through the existing external test boundary. The
  // legacy route still accepts its current event shape without B2a timestamps.
  const sdk = await vi.importActual<typeof import("@clerk/backend/webhooks")>(
    "@clerk/backend/webhooks",
  );
  const secret = `whsec_${Buffer.from("synthetic-route-secret").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(
    async (request: unknown) => {
      if (!(request instanceof Request)) {
        throw new Error("expected raw Request");
      }
      return await sdk.verifyWebhook(request, { signingSecret: secret });
    },
  );
  mocks.clerk.session(
    `synthetic_survivor_${randomUUID()}`,
    `synthetic_org_${randomUUID()}`,
  );
  context.mocks.s3.send.mockResolvedValue({});
  const agents = setupApp({ context, routes: agentsRoutes })(
    agentsMainContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const created = await accept(
    agents.create({
      headers,
      body: { displayName: "Surviving owner's agent" },
    }),
    [201],
  );
  const body = JSON.stringify({
    type: "user.deleted",
    data: { id: `synthetic_deleted_${randomUUID()}`, deleted: true },
  });
  const id = randomUUID();
  const timestamp = nowDate();
  const signature = new Webhook(secret).sign(id, timestamp, body);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  const listed = await accept(agents.list({ headers }), [200]);
  expect(listed.body).toContainEqual(created.body);
});

test("does not recreate erased generation metadata from an authenticated connector write", async () => {
  const sdk = await vi.importActual<typeof import("@clerk/backend/webhooks")>(
    "@clerk/backend/webhooks",
  );
  const secret = `whsec_${Buffer.from("connector-writer-erasure").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(
    async (request: unknown) => {
      if (!(request instanceof Request)) {
        throw new Error("expected raw Request");
      }
      return await sdk.verifyWebhook(request, { signingSecret: secret });
    },
  );
  const orgId = `synthetic_org_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const deletedUserId = `synthetic_deleted_${randomUUID()}`;
  mocks.clerk.session(survivingUserId, orgId);
  context.mocks.s3.send.mockResolvedValue({});
  const agents = setupApp({ context, routes: agentsRoutes })(
    agentsMainContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const created = await accept(
    agents.create({
      headers,
      body: { displayName: "Surviving public agent", visibility: "public" },
    }),
    [201],
  );

  mocks.clerk.session(deletedUserId, orgId);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdUserConnectorMutationBeforeAdmissionFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const update = setupApp({ context, routes: agentsRoutes })(
    userConnectorsContract,
  ).update({
    params: { id: created.body.agentId },
    body: { enabledConnectorSlugs: [], operation: "remove" },
    headers,
  });
  await entered.promise;

  const body = JSON.stringify({
    type: "user.deleted",
    data: { id: deletedUserId, deleted: true },
  });
  const id = randomUUID();
  const timestamp = nowDate();
  const signature = new Webhook(secret).sign(id, timestamp, body);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();

  release.resolve();
  await accept(update, [404]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: created.body.agentId,
      userId: deletedUserId,
    }),
  ).resolves.toBe(0);
});

test("does not recreate erased generation metadata from an authenticated permission write", async () => {
  const sdk = await vi.importActual<typeof import("@clerk/backend/webhooks")>(
    "@clerk/backend/webhooks",
  );
  const secret = `whsec_${Buffer.from("permission-writer-erasure").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(
    async (request: unknown) => {
      if (!(request instanceof Request)) {
        throw new Error("expected raw Request");
      }
      return await sdk.verifyWebhook(request, { signingSecret: secret });
    },
  );
  const orgId = `synthetic_org_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const deletedUserId = `synthetic_deleted_${randomUUID()}`;
  mocks.clerk.session(survivingUserId, orgId);
  context.mocks.s3.send.mockResolvedValue({});
  const headers = { authorization: "Bearer clerk-session" };
  const created = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { displayName: "Surviving public agent", visibility: "public" },
    }),
    [201],
  );

  mocks.clerk.session(deletedUserId, orgId);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdUserPermissionGrantMutationBeforeAdmissionFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const apply = setupApp({ context, routes: userPermissionGrantsRoutes })(
    userPermissionGrantsContract,
  ).apply({
    body: {
      agentId: created.body.agentId,
      connectorSlug: "slack",
      mode: "replace",
      grants: [],
    },
    headers,
  });
  await entered.promise;

  const body = JSON.stringify({
    type: "user.deleted",
    data: { id: deletedUserId, deleted: true },
  });
  const id = randomUUID();
  const timestamp = nowDate();
  const signature = new Webhook(secret).sign(id, timestamp, body);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": signature,
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();

  release.resolve();
  await accept(apply, [404]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: created.body.agentId,
      userId: deletedUserId,
    }),
  ).resolves.toBe(0);
});

test("does not recreate erased generation metadata from private Workflow creation", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const deletedUserId = `synthetic_deleted_${randomUUID()}`;
  mocks.clerk.session(survivingUserId, orgId);
  context.mocks.s3.send.mockResolvedValue({});
  const headers = { authorization: "Bearer clerk-session" };
  const createdAgent = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { displayName: "Surviving public agent", visibility: "public" },
    }),
    [201],
  );

  mocks.clerk.session(deletedUserId, orgId);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdWorkflowCreationBeforeErasureAdmissionFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const creation = setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  ).create({
    headers,
    body: {
      agentId: createdAgent.body.agentId,
      name: `late-private-${randomUUID().slice(0, 8)}`,
      visibility: "private",
      instruction: "# must not survive erasure",
    },
  });
  await entered.promise;
  await deleteUserWithSignedWebhook(
    deletedUserId,
    "workflow-create-writer-erasure",
  );

  release.resolve();
  await accept(creation, [404]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: createdAgent.body.agentId,
      userId: deletedUserId,
    }),
  ).resolves.toBe(0);
});

test("does not recreate erased generation metadata from Workflow Copy", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const deletedUserId = `synthetic_deleted_${randomUUID()}`;
  mocks.clerk.session(survivingUserId, orgId, "org:admin");
  context.mocks.s3.send.mockResolvedValue({});
  const headers = { authorization: "Bearer clerk-session" };
  const agents = setupApp({ context, routes: agentsRoutes })(
    agentsMainContract,
  );
  const sourceAgent = await accept(
    agents.create({
      headers,
      body: { displayName: "Surviving source agent", visibility: "public" },
    }),
    [201],
  );
  const targetAgent = await accept(
    agents.create({
      headers,
      body: { displayName: "Surviving target agent", visibility: "public" },
    }),
    [201],
  );
  const source = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers,
      body: {
        agentId: sourceAgent.body.agentId,
        name: `public-copy-source-${randomUUID().slice(0, 8)}`,
        visibility: "public",
        instruction: "# surviving public source",
      },
    }),
    [201],
  );

  mocks.clerk.session(deletedUserId, orgId, "org:admin");
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdWorkflowCopyBeforeErasureAdmissionFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const copy = setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  ).copy({
    headers,
    params: { workflowId: source.body.id },
    body: { toAgentId: targetAgent.body.agentId },
  });
  await entered.promise;
  await deleteUserWithSignedWebhook(
    deletedUserId,
    "workflow-copy-writer-erasure",
  );

  release.resolve();
  await accept(copy, [409]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: targetAgent.body.agentId,
      userId: deletedUserId,
    }),
  ).resolves.toBe(0);
});

test.each(["update", "delete"] as const)(
  "does not recreate erased generation metadata from private Workflow %s",
  async (operation) => {
    const orgId = `synthetic_org_${randomUUID()}`;
    const survivingUserId = `synthetic_survivor_${randomUUID()}`;
    const deletedUserId = `synthetic_deleted_${randomUUID()}`;
    context.mocks.s3.send.mockResolvedValue({});
    const headers = { authorization: "Bearer clerk-session" };

    mocks.clerk.session(survivingUserId, orgId, "org:admin");
    const agent = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
        headers,
        body: { displayName: "Surviving public agent", visibility: "public" },
      }),
      [201],
    );

    mocks.clerk.session(deletedUserId, orgId, "org:member");
    const workflow = await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).create({
        headers,
        body: {
          agentId: agent.body.agentId,
          name: `late-${operation}-${randomUUID().slice(0, 8)}`,
          visibility: "private",
          instruction: "# before erasure",
        },
      }),
      [201],
    );

    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    if (operation === "update") {
      holdWorkflowUpdateBeforeErasureAdmissionFixture(hold);
    } else {
      holdWorkflowDeleteBeforeErasureAdmissionFixture(hold);
    }
    const client = setupApp({ context, routes: workflowsRoutes })(
      workflowsDetailContract,
    );
    const mutation =
      operation === "update"
        ? accept(
            client.update({
              headers,
              params: { workflowId: workflow.body.id },
              body: { instruction: "# must not survive erasure" },
            }),
            [409],
          )
        : accept(
            client.delete({
              headers,
              params: { workflowId: workflow.body.id },
            }),
            [404],
          );
    await entered.promise;
    await deleteUserWithSignedWebhook(
      deletedUserId,
      `workflow-${operation}-writer-erasure`,
    );

    release.resolve();
    await mutation;
    await expect(
      countUserStableContextGenerationsFixture({
        agentId: agent.body.agentId,
        userId: deletedUserId,
      }),
    ).resolves.toBe(0);
    await expect(
      countAgentStableContextPublicationsFixture(agent.body.agentId),
    ).resolves.toBe(0);
  },
);

test("does not recreate erased generation metadata when clearing a thread connector selection", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const deletedUserId = `synthetic_deleted_${randomUUID()}`;
  const fixture = await createPublicAgentThread({
    orgId,
    ownerUserId: survivingUserId,
    threadUserId: deletedUserId,
  });
  const headers = { authorization: "Bearer clerk-session" };

  mocks.clerk.session(deletedUserId, orgId);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdChatThreadConnectorSelectionBeforeErasureAdmissionFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const clear = setupApp({
    context,
    routes: chatThreadConnectorSelectionRoutes,
  })(chatThreadConnectorSelectionContract).clear({
    headers,
    params: { id: fixture.chatThreadId },
    body: { kind: "builtin", connectorSlug: "openai" },
  });
  await entered.promise;
  await deleteUserWithSignedWebhook(
    deletedUserId,
    "thread-selection-writer-erasure",
  );

  release.resolve();
  await accept(clear, [404]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: fixture.agentId,
      userId: deletedUserId,
    }),
  ).resolves.toBe(0);
});

test("completes signed Agent-owner erasure behind a surviving Workflow update", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const ownerUserId = `synthetic_owner_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const headers = { authorization: "Bearer clerk-session" };
  context.mocks.s3.send.mockResolvedValue({});

  mocks.clerk.session(ownerUserId, orgId, "org:admin");
  const agent = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { displayName: "Erased public owner", visibility: "public" },
    }),
    [201],
  );
  mocks.clerk.session(survivingUserId, orgId, "org:member");
  const workflow = await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers,
      body: {
        agentId: agent.body.agentId,
        name: `surviving-private-${randomUUID().slice(0, 8)}`,
        visibility: "private",
        instruction: "# existing generation",
      },
    }),
    [201],
  );
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: agent.body.agentId,
      userId: survivingUserId,
    }),
  ).resolves.toBeGreaterThan(0);

  const writerEntered = createDeferredPromise<number>(context.signal);
  const cleanupEntered = createDeferredPromise<number>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdWorkflowUpdateAfterMetadataMutationFixture(async (tx) => {
    const result = await tx.execute(sql`SELECT pg_backend_pid()::int AS "pid"`);
    writerEntered.resolve(Number(result.rows[0]?.pid));
    await release.promise;
  });
  observeClerkAgentLifecycleBeforeAgentLockFixture(async (tx, agentId) => {
    if (agentId !== agent.body.agentId) {
      return;
    }
    const result = await tx.execute(sql`SELECT pg_backend_pid()::int AS "pid"`);
    cleanupEntered.resolve(Number(result.rows[0]?.pid));
  });
  const client = setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
  const update = client.update({
    headers,
    params: { workflowId: workflow.body.id },
    body: { instruction: "# commits before owner erasure" },
  });
  const writerPid = await writerEntered.promise;
  await deleteUserWithSignedWebhook(
    ownerUserId,
    "workflow-update-agent-owner-erasure",
    { flush: false },
  );
  const cleanupPid = await cleanupEntered.promise;
  await expect
    .poll(
      async () => {
        return await stableContextBackendBlockedByFixture({
          blockedPid: cleanupPid,
          blockerPid: writerPid,
        });
      },
      { interval: 5, timeout: 80 },
    )
    .toBe(true);
  release.resolve();
  await accept(update, [409]);
  await flushWaitUntilForTest();

  await expect(
    countUserStableContextGenerationsFixture({
      agentId: agent.body.agentId,
      userId: survivingUserId,
    }),
  ).resolves.toBe(0);
  await expect(
    countAgentStableContextPublicationsFixture(agent.body.agentId),
  ).resolves.toBe(0);
  await accept(
    client.get({ headers, params: { workflowId: workflow.body.id } }),
    [404],
  );
});

test("completes signed Agent-owner erasure behind scoped artifact GC", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const ownerUserId = `synthetic_owner_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const headers = { authorization: "Bearer clerk-session" };
  context.mocks.s3.send.mockResolvedValue({});

  mocks.clerk.session(ownerUserId, orgId, "org:admin");
  const agent = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { displayName: "GC-erased public owner", visibility: "public" },
    }),
    [201],
  );
  bdd.acceptAgentStorageWrites();
  await bdd.updateAgentInstructions(
    bdd.user({ orgId, userId: ownerUserId, orgRole: "org:admin" }),
    agent.body.agentId,
    "# instructions retained by another audience artifact",
  );
  const instructions = await readAgentInstructionsStorageFixture(
    agent.body.agentId,
  );
  const headId = await seedPiStableContextStorageDemandFixture({
    orgId,
    userId: survivingUserId,
    agentId: agent.body.agentId,
    storageName: instructions.storageName,
    versionId: instructions.versionId,
    archiveSize: instructions.archiveSize,
    resourceOrgId: orgId,
    resourceUserId: instructions.resourceUserId,
    ready: true,
  });
  const artifactDigest = await removePiStableContextHeadFixture(headId);
  const gcEntered = createDeferredPromise<number>(context.signal);
  const releaseGc = createDeferredPromise<void>(context.signal);
  const gc = deleteExpiredOwnedPiStableContextArtifactFixture({
    artifactDigest,
    cutoff: new Date("2099-01-01T00:00:00.000Z"),
    afterCandidatesLocked: async (tx) => {
      const result = await tx.execute(
        sql`SELECT pg_backend_pid()::int AS "pid"`,
      );
      gcEntered.resolve(Number(result.rows[0]?.pid));
      await releaseGc.promise;
    },
  });
  const gcPid = await gcEntered.promise;
  const cleanupEntered = createDeferredPromise<number>(context.signal);
  observeClerkAgentLifecycleBeforeAgentLockFixture(async (tx, agentId) => {
    if (agentId !== agent.body.agentId) {
      return;
    }
    const result = await tx.execute(sql`SELECT pg_backend_pid()::int AS "pid"`);
    cleanupEntered.resolve(Number(result.rows[0]?.pid));
  });
  await deleteUserWithSignedWebhook(ownerUserId, "gc-agent-owner-erasure", {
    flush: false,
  });
  const cleanupPid = await cleanupEntered.promise;
  await expect
    .poll(
      async () => {
        return await stableContextBackendBlockedByFixture({
          blockedPid: cleanupPid,
          blockerPid: gcPid,
        });
      },
      { interval: 5, timeout: 500 },
    )
    .toBe(true);
  releaseGc.resolve();
  await expect(gc).resolves.toStrictEqual([{ digest: artifactDigest }]);
  await flushWaitUntilForTest();
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: agent.body.agentId,
      userId: survivingUserId,
    }),
  ).resolves.toBe(0);
});

test("orders multi-Agent instruction Storage cleanup before scoped artifact GC", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const ownerUserId = `synthetic_owner_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const headers = { authorization: "Bearer clerk-session" };
  context.mocks.s3.send.mockResolvedValue({});

  mocks.clerk.session(ownerUserId, orgId, "org:admin");
  const createdAgents = await Promise.all(
    ["Storage order A", "Storage order B"].map(async (displayName) => {
      return await accept(
        setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
          headers,
          body: { displayName, visibility: "public" },
        }),
        [201],
      );
    }),
  );
  const orderedAgents = [...createdAgents].sort((left, right) => {
    return left.body.agentId.localeCompare(right.body.agentId);
  });
  const storageIds = [
    "ffffffff-ffff-4fff-bfff-ffffffffffff",
    "00000000-0000-4000-8000-000000000001",
  ] as const;
  const instructions = await Promise.all(
    orderedAgents.map(async (agent, index) => {
      return await seedAgentInstructionsStorageWithIdFixture({
        agentId: agent.body.agentId,
        storageId: storageIds[index]!,
      });
    }),
  );
  const artifactDigests = await Promise.all(
    orderedAgents.map(async (agent, index) => {
      const storage = instructions[index]!;
      const headId = await seedPiStableContextStorageDemandFixture({
        orgId,
        userId: survivingUserId,
        agentId: agent.body.agentId,
        storageName: storage.storageName,
        versionId: storage.versionId,
        archiveSize: storage.archiveSize,
        resourceOrgId: orgId,
        resourceUserId: storage.resourceUserId,
        ready: true,
      });
      return await removePiStableContextHeadFixture(headId);
    }),
  );

  const cleanupLocked = createDeferredPromise<{
    readonly pid: number;
    readonly storageIds: readonly string[];
  }>(context.signal);
  const releaseCleanup = createDeferredPromise<void>(context.signal);
  holdClerkAgentLifecycleAfterInstructionsStorageLocksFixture(
    async (tx, lockedStorageIds) => {
      const result = await tx.execute(
        sql`SELECT pg_backend_pid()::int AS "pid"`,
      );
      cleanupLocked.resolve({
        pid: Number(result.rows[0]?.pid),
        storageIds: lockedStorageIds,
      });
      await releaseCleanup.promise;
    },
  );
  await deleteUserWithSignedWebhook(ownerUserId, "multi-storage-gc-erasure", {
    flush: false,
  });
  const cleanup = await cleanupLocked.promise;
  expect(cleanup.storageIds).toStrictEqual([storageIds[1], storageIds[0]]);

  const gcEntered = createDeferredPromise<number>(context.signal);
  const gc = deleteExpiredOwnedPiStableContextArtifactFixture({
    artifactDigests,
    cutoff: new Date("2099-01-01T00:00:00.000Z"),
    beforeStorageLocks: async (tx) => {
      const result = await tx.execute(
        sql`SELECT pg_backend_pid()::int AS "pid"`,
      );
      gcEntered.resolve(Number(result.rows[0]?.pid));
    },
  });
  const gcPid = await gcEntered.promise;
  await expect
    .poll(
      async () => {
        return await stableContextBackendBlockedByFixture({
          blockedPid: gcPid,
          blockerPid: cleanup.pid,
        });
      },
      { interval: 5, timeout: 500 },
    )
    .toBe(true);

  releaseCleanup.resolve();
  await flushWaitUntilForTest();
  await expect(gc).resolves.toStrictEqual([]);
  for (const agent of orderedAgents) {
    await expect(
      countUserStableContextGenerationsFixture({
        agentId: agent.body.agentId,
        userId: survivingUserId,
      }),
    ).resolves.toBe(0);
  }
});

test("does not recreate stable state after the public Agent owner is erased", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const ownerUserId = `synthetic_owner_${randomUUID()}`;
  const threadUserId = `synthetic_thread_user_${randomUUID()}`;
  const fixture = await createPublicAgentThread({
    orgId,
    ownerUserId,
    threadUserId,
  });
  const headers = { authorization: "Bearer clerk-session" };

  mocks.clerk.session(threadUserId, orgId);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdChatThreadConnectorSelectionBeforeAgentLockFixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const clear = setupApp({
    context,
    routes: chatThreadConnectorSelectionRoutes,
  })(chatThreadConnectorSelectionContract).clear({
    headers,
    params: { id: fixture.chatThreadId },
    body: { kind: "builtin", connectorSlug: "github" },
  });
  await entered.promise;
  await deleteUserWithSignedWebhook(
    ownerUserId,
    "thread-selection-agent-owner-erasure",
  );

  release.resolve();
  await accept(clear, [404]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: fixture.agentId,
      userId: threadUserId,
    }),
  ).resolves.toBe(0);
});
