import { randomUUID } from "node:crypto";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { agentsRoutes } from "../agents";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncSessionHeaders as headers,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
const mocks = createRouteMocks(context);
const store = createStore();
beforeEach(initializeVncRuntimeTest);

test("completes member cleanup and shared-Agent deletion concurrently", async () => {
  const creator = await api.fixture({ runtime: { status: "completed" } });
  const consumer = {
    orgId: creator.orgId,
    userId: `user_vnc_cleanup_${randomUUID()}`,
  };
  await updateFeatureSwitchesForUser(context, consumer, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  api.authenticate(consumer);
  await accept(
    api.connections().create({ headers, body: vncConnectionBody() }),
    [201],
  );
  // The fleet fixture represents an unclaimed queued Run, which Agent deletion
  // permits. A running Run would return 409 before owner cleanup can complete.
  await api.runtime(consumer, {
    agentId: creator.agentId,
    status: "queued",
    runnerId: null,
    heartbeatGeneration: null,
  });
  const membershipId = `orgmem_${randomUUID()}`;
  await store.set(seedOrgMembership$, creator, context.signal);
  await store.set(
    seedOrgMembership$,
    { ...consumer, membershipId },
    context.signal,
  );
  mocks.s3.listObjects([]);
  const removeAgent = () => {
    mocks.clerk.session(creator.userId, creator.orgId);
    return setupApp({ context, routes: agentsRoutes })(
      agentsByIdContract,
    ).delete({ headers, params: { id: creator.agentId } });
  };
  mockOptionalEnv(
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "synthetic-vnc-signing-secret",
  );
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
    type: "organizationMembership.deleted",
    data: {
      id: membershipId,
      organization_id: consumer.orgId,
      user_id: consumer.userId,
    },
  });
  await Promise.all([
    accept(removeAgent(), [204]),
    accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: "{}" }),
      [200],
    ),
  ]);
  await flushWaitUntilForTest();
  await updateFeatureSwitchesForUser(context, consumer, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  api.authenticate(consumer);
  expect(
    (await accept(api.connections().list({ headers }), [200])).body.connections,
  ).toStrictEqual([]);
  api.authenticate(creator);
  expect(
    (await accept(api.connections().list({ headers }), [200])).body.connections,
  ).toContainEqual(expect.objectContaining({ id: creator.connectionId }));
});
