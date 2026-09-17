import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { countUserStableContextGenerationsFixture } from "../../../test-fixtures/pi-stable-context";
import { holdUserConnectorMutationBeforeAdmissionFixture } from "../../../test-fixtures/user-connectors";
import { agentsRoutes } from "../agents";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

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
