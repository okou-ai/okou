import { randomUUID } from "node:crypto";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Webhook } from "svix";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { testClerkUserDeletionJobContract } from "@okouai/api-contracts/contracts/test-clerk-user-deletion-job";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, onRejection } from "../../utils";
import {
  countAgentStableContextPublicationsFixture,
  countUserStableContextGenerationsFixture,
  deleteExpiredOwnedPiStableContextArtifactFixture,
  readAgentInstructionsStorageFixture,
  removePiStableContextHeadFixture,
  seedAgentInstructionsStorageWithIdFixture,
  seedPiStableContextStorageDemandFixture,
} from "../../../test-fixtures/pi-stable-context";
import { holdUserConnectorMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-connectors";
import { holdUserPermissionGrantMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-permission-grants";
import {
  holdChatThreadConnectorSelectionBeforeAgentLockFixture,
  holdChatThreadConnectorSelectionBeforeErasureAdmissionFixture,
  holdWorkflowCopyBeforeErasureAdmissionFixture,
  holdWorkflowCreationBeforeErasureAdmissionFixture,
  holdWorkflowDeleteBeforeErasureAdmissionFixture,
  holdWorkflowUpdateAfterMetadataMutationFixture,
  holdWorkflowUpdateBeforeErasureAdmissionFixture,
} from "../../../test-fixtures/pi-stable-context-source-writers";
import { agentsRoutes } from "../agents";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { testClerkUserDeletionJobRoutes } from "../test-clerk-user-deletion-job";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { workflowsRoutes } from "../workflows";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const storages = createStoragesBddApi(context);
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

test.each(["list", "delete"] as const)(
  "retains user Storage without attempting S3 %s during the hold",
  async (failure) => {
    const userId = `synthetic_deleted_${randomUUID()}`;
    const orgId = `synthetic_org_${randomUUID()}`;
    const actor = bdd.user({ userId, orgId });
    const storageName = `erasure-${randomUUID()}`;
    storages.mockStoragePresignedUrls();
    await storages.prepareStorage(actor, {
      storageName,
      storageOwner: "user",
      files: [],
    });

    let failNext = true;
    let failed = false;
    let deleteCount = 0;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix;
        if (!prefix?.startsWith(`${orgId}/`)) {
          return Promise.resolve({ Contents: [] });
        }
        if (failure === "list" && failNext) {
          failNext = false;
          failed = true;
          return Promise.reject(new Error("synthetic S3 listing failure"));
        }
        return Promise.resolve({
          Contents: [
            { Key: `${prefix}version`, Size: 1, LastModified: nowDate() },
          ],
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        const isStorage = command.input.Delete?.Objects?.some((item) => {
          return item.Key?.startsWith(`${orgId}/`);
        });
        if (isStorage && failure === "delete" && failNext) {
          failNext = false;
          failed = true;
          return Promise.reject(new Error("synthetic S3 deletion failure"));
        }
        if (isStorage) {
          deleteCount += 1;
        }
      }
      return Promise.resolve({});
    });

    await deleteUserWithSignedWebhook(userId, `preserve-locators-${failure}`);
    expect(failed).toBe(false);
    await expect(storages.listStorages(actor, "user")).resolves.toContainEqual(
      expect.objectContaining({ name: storageName }),
    );

    mockEnv("ENV", "development");
    const resumed = await accept(
      setupApp({ context, routes: testClerkUserDeletionJobRoutes })(
        testClerkUserDeletionJobContract,
      ).retry({
        body: { userId },
      }),
      [200],
    );
    expect(resumed.body.processed).toBe(1);
    expect(failed).toBe(false);
    expect(deleteCount).toBe(0);
    await expect(storages.listStorages(actor, "user")).resolves.toContainEqual(
      expect.objectContaining({ name: storageName }),
    );

    await deleteUserWithSignedWebhook(userId, `duplicate-${failure}`);
    expect(deleteCount).toBe(0);
  },
);

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
    userBuiltinConnectorsContract,
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
  "does not add generation metadata after holding private Workflow %s",
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

    const generationsBefore = await countUserStableContextGenerationsFixture({
      agentId: agent.body.agentId,
      userId: deletedUserId,
    });
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
    ).resolves.toBe(generationsBefore);
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

test("holds owner deletion while another member finishes updating a Workflow", async () => {
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

  const writerEntered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  holdWorkflowUpdateAfterMetadataMutationFixture(async () => {
    writerEntered.resolve();
    await release.promise;
  });
  const client = setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
  const update = client.update({
    headers,
    params: { workflowId: workflow.body.id },
    body: { instruction: "# commits before owner erasure" },
  });
  await writerEntered.promise;
  await deleteUserWithSignedWebhook(
    ownerUserId,
    "workflow-update-agent-owner-erasure",
    { flush: false },
  );
  // Holding user erasure does not wait for or delete the other member's work.
  await flushWaitUntilForTest();
  release.resolve();
  await accept(update, [200]);
  const committed = await accept(
    client.get({ headers, params: { workflowId: workflow.body.id } }),
    [200],
  );
  expect(committed.body.instruction).toBe("# commits before owner erasure");

  mockEnv("ENV", "development");
  const retried = await accept(
    setupApp({ context, routes: testClerkUserDeletionJobRoutes })(
      testClerkUserDeletionJobContract,
    ).retry({ body: { userId: ownerUserId } }),
    [200],
  );
  expect(retried.body.processed).toBe(1);

  await expect(
    countUserStableContextGenerationsFixture({
      agentId: agent.body.agentId,
      userId: survivingUserId,
    }),
  ).resolves.toBeGreaterThan(0);
  await accept(
    client.get({ headers, params: { workflowId: workflow.body.id } }),
    [200],
  );
});

test("allows another member's Workflow update to finish after the Agent owner's deletion", async () => {
  const orgId = `synthetic_org_${randomUUID()}`;
  const ownerUserId = `synthetic_owner_${randomUUID()}`;
  const survivingUserId = `synthetic_survivor_${randomUUID()}`;
  const headers = { authorization: "Bearer clerk-session" };
  context.mocks.s3.send.mockResolvedValue({});

  mocks.clerk.session(ownerUserId, orgId, "org:admin");
  const agent = await accept(
    setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
      headers,
      body: { displayName: "Erased upload owner", visibility: "public" },
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
        name: `surviving-upload-${randomUUID().slice(0, 8)}`,
        visibility: "private",
        instruction: "# existing generation",
      },
    }),
    [201],
  );

  const uploadEntered = createDeferredPromise<void>(context.signal);
  const releaseUpload = createDeferredPromise<void>(context.signal);
  let holdArchiveUpload = true;
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (
      holdArchiveUpload &&
      command instanceof PutObjectCommand &&
      command.input.Key?.endsWith("/archive.tar.gz")
    ) {
      holdArchiveUpload = false;
      uploadEntered.resolve();
      await releaseUpload.promise;
    }
    return {};
  });
  const client = setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
  const update = client.update({
    headers,
    params: { workflowId: workflow.body.id },
    body: { instruction: "# cannot publish after owner erasure" },
  });
  await uploadEntered.promise;
  await deleteUserWithSignedWebhook(
    ownerUserId,
    "workflow-upload-owner-erasure",
  );

  releaseUpload.resolve();
  const committed = await accept(update, [200]);
  expect(committed.body.instruction).toBe(
    "# cannot publish after owner erasure",
  );
  await accept(
    client.get({ headers, params: { workflowId: workflow.body.id } }),
    [200],
  );
});

test("holds Agent-owner erasure while independent scoped artifact GC finishes", async () => {
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
  const gcEntered = createDeferredPromise<void>(context.signal);
  const releaseGc = createDeferredPromise<void>(context.signal);
  const gc = onRejection(
    deleteExpiredOwnedPiStableContextArtifactFixture({
      artifactDigest,
      cutoff: new Date("2099-01-01T00:00:00.000Z"),
      afterCandidatesLocked: async () => {
        gcEntered.resolve();
        await releaseGc.promise;
      },
    }),
    (error) => {
      if (!gcEntered.settled()) {
        gcEntered.reject(error);
      }
    },
  );
  await gcEntered.promise;
  await onRejection(
    deleteUserWithSignedWebhook(ownerUserId, "gc-agent-owner-erasure"),
    () => {
      releaseGc.resolve();
    },
  );
  releaseGc.resolve();
  await expect(gc).resolves.toStrictEqual([{ digest: artifactDigest }]);
  const retained = await readAgentInstructionsStorageFixture(
    agent.body.agentId,
  );
  expect(retained.storageId).toBe(instructions.storageId);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: agent.body.agentId,
      userId: survivingUserId,
    }),
  ).resolves.toBeGreaterThan(0);
});

test("retains two Agents' instruction Storage and another member's generations", async () => {
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
  const storageIds = [randomUUID(), randomUUID()] as const;
  const instructions = await Promise.all(
    orderedAgents.map(async (agent, index) => {
      return await seedAgentInstructionsStorageWithIdFixture({
        agentId: agent.body.agentId,
        storageId: storageIds[index]!,
      });
    }),
  );
  await Promise.all(
    orderedAgents.map(async (agent, index) => {
      const storage = instructions[index]!;
      await seedPiStableContextStorageDemandFixture({
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
    }),
  );
  await deleteUserWithSignedWebhook(ownerUserId, "multi-storage-held");
  for (const [index, agent] of orderedAgents.entries()) {
    const retained = await readAgentInstructionsStorageFixture(
      agent.body.agentId,
    );
    expect(retained.storageId).toBe(instructions[index]!.storageId);
    await expect(
      countUserStableContextGenerationsFixture({
        agentId: agent.body.agentId,
        userId: survivingUserId,
      }),
    ).resolves.toBeGreaterThan(0);
  }
});

test("preserves another member's thread and stable state when the public Agent owner is deleted", async () => {
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
  await accept(clear, [204]);
  await expect(
    countUserStableContextGenerationsFixture({
      agentId: fixture.agentId,
      userId: threadUserId,
    }),
  ).resolves.toBeGreaterThan(0);
});
