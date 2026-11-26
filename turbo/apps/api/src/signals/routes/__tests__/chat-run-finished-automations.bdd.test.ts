import { randomUUID } from "node:crypto";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const workflowsApi = app(workflowsCollectionContract);
const automationsApi = app(workflowAutomationsContract);

function signIn(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

async function grantProPlan(user: ApiTestUser): Promise<void> {
  const suffix = randomUUID();
  const customerId = `cus_pro_${suffix}`;
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId: user.orgId },
  });
  await webhooks.postStripeEvent(
    {
      id: `evt_pro_${suffix}`,
      type: "customer.subscription.created",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: `sub_pro_${suffix}`,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          trial_end: null,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();
}

describe("chat-run-finished workflow automations", () => {
  it("chat-run-finished-automations.bdd-002 requires the watched chat thread to belong to the automation owner", async () => {
    context.mocks.s3.send.mockResolvedValue({
      ContentLength: 256,
      ETag: "workflow-etag",
    });
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Expected owner orgId");
    }
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    await grantProPlan(owner);

    const workflow = await accept(
      workflowsApi.create({
        headers: signIn(owner),
        body: {
          name: `watch-owner-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    );

    const peerThread = await accept(
      threadsApi.create({
        headers: signIn(peer),
        body: { title: "Peer thread" },
      }),
      [201],
    );

    const unknownAttempt = await accept(
      automationsApi.create({
        headers: signIn(owner),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: randomUUID(),
          },
        },
      }),
      [400],
    );
    expect(unknownAttempt.body.error.message).toContain(
      "Chat thread not found",
    );

    const peerAttempt = await accept(
      automationsApi.create({
        headers: signIn(owner),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: peerThread.body.id,
          },
        },
      }),
      [400],
    );
    expect(peerAttempt.body.error.message).toContain("Chat thread not found");
  });

  it("chat-run-finished-automations.bdd-003 prevents a workflow from watching its own chat thread", async () => {
    context.mocks.s3.send.mockResolvedValue({
      ContentLength: 256,
      ETag: "workflow-etag",
    });
    const owner = bdd.user();
    await grantProPlan(owner);

    const ownThread = await accept(
      threadsApi.create({
        headers: signIn(owner),
        body: { title: "Workflow thread" },
      }),
      [201],
    );

    const workflow = await accept(
      workflowsApi.create({
        headers: signIn(owner),
        body: {
          name: `self-watch-${randomUUID().slice(0, 8)}`,
          chatThreadId: ownThread.body.id,
          visibility: "private",
        },
      }),
      [201],
    );

    const selfAttempt = await accept(
      automationsApi.create({
        headers: signIn(owner),
        params: { workflowId: workflow.body.id },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: ownThread.body.id,
          },
        },
      }),
      [400],
    );
    expect(selfAttempt.body.error.message).toBe(
      "A workflow cannot watch run-finished events from its own chat thread",
    );
  });
});
