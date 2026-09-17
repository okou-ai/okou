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
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { countUserStableContextGenerationsFixture } from "../../../test-fixtures/pi-stable-context";
import { holdUserConnectorMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-connectors";
import { holdUserPermissionGrantMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-permission-grants";
import {
  holdChatThreadConnectorSelectionBeforeErasureAdmissionFixture,
  holdWorkflowCopyBeforeErasureAdmissionFixture,
  holdWorkflowCreationBeforeErasureAdmissionFixture,
  seedChatThreadForStableContextWriterFixture,
} from "../../../test-fixtures/pi-stable-context-source-writers";
import { agentsRoutes } from "../agents";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { workflowsRoutes } from "../workflows";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

async function deleteUserWithSignedWebhook(
  userId: string,
  secretLabel: string,
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
  await flushWaitUntilForTest();
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

test("does not recreate erased generation metadata when clearing a thread connector selection", async () => {
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
  const chatThreadId = await seedChatThreadForStableContextWriterFixture({
    userId: deletedUserId,
    agentId: createdAgent.body.agentId,
  });

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
    params: { id: chatThreadId },
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
      agentId: createdAgent.body.agentId,
      userId: deletedUserId,
    }),
  ).resolves.toBe(0);
});
