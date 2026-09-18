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
import { onRejection } from "../../utils";
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

test("orders member cleanup with shared-Agent deletion and permits deletion after the queued Run is revoked", async () => {
  const creator = await api.fixture({
    grant: false,
    runtime: { status: "completed" },
  });
  const consumer = {
    orgId: creator.orgId,
    userId: `user_vnc_cleanup_${randomUUID()}`,
  };
  await updateFeatureSwitchesForUser(context, consumer, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  api.authenticate(consumer);
  const connection = await accept(
    api.connections().create({ headers, body: vncConnectionBody() }),
    [201],
  );
  // The fleet fixture represents an unclaimed queued Run, which Agent deletion
  // permits. A running Run would return 409 before reaching the grant cascade.
  await api.runtime(consumer, {
    agentId: creator.agentId,
    status: "queued",
    runnerId: null,
    heartbeatGeneration: null,
  });
  await api.grant({ ...consumer, agentId: creator.agentId }, true);
  const membershipId = `orgmem_${randomUUID()}`;
  await store.set(seedOrgMembership$, creator, context.signal);
  await store.set(
    seedOrgMembership$,
    { ...consumer, membershipId },
    context.signal,
  );
  mocks.s3.listObjects([]);
  const lock = (
    action:
      | "hold-connection-lock"
      | "read-connection-lock"
      | "release-connection-lock",
  ) => {
    return accept(
      api.state().action({
        body: { action, ...consumer, connectionId: connection.body.id },
      }),
      [200],
    );
  };
  const removeAgent = () => {
    mocks.clerk.session(creator.userId, creator.orgId);
    return setupApp({ context, routes: agentsRoutes })(
      agentsByIdContract,
    ).delete({ headers, params: { id: creator.agentId } });
  };
  // Hold an external PostgreSQL row lock to make both real lifecycle requests
  // overlap deterministically; production callers cannot manufacture this wait.
  const held = lock("hold-connection-lock");
  await expect
    .poll(async () => {
      return (await lock("read-connection-lock")).body.held;
    })
    .toBe(true);
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
  const cleanup = (async () => {
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: "{}" }),
      [200],
    );
    await flushWaitUntilForTest();
  })();
  const release = async () => {
    await lock("release-connection-lock");
    await Promise.all([held, cleanup]);
  };
  await onRejection(
    (async () => {
      await expect
        .poll(async () => {
          return (await lock("read-connection-lock")).body.waiting;
        })
        .toBe(true);
      // Member cleanup must fence the shared Agent's cascade before retaining its
      // grant rows and revoking its queued Run, avoiding grant->Run / Run->grant.
      await accept(removeAgent(), [409]);
    })(),
    release,
  );
  await release();
  await updateFeatureSwitchesForUser(context, consumer, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  api.authenticate(consumer);
  expect(
    (await accept(api.connections().list({ headers }), [200])).body.connections,
  ).toStrictEqual([]);
  expect(
    (
      await accept(
        api.access().get({ headers, params: { agentId: creator.agentId } }),
        [200],
      )
    ).body,
  ).toStrictEqual({ enabled: false });
  await accept(removeAgent(), [204]);
});
