import {
  webhookStripeContract,
  webhookWorkflowAutomationContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const DAY_SECONDS = 86_400;

const appFor = setupApp({
  context,
  routes: [
    ...webhooksStripeRoutes,
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
    ...webhooksWorkflowAutomationsRoutes,
  ],
});
const stripeWebhook = appFor(webhookStripeContract);
const workflows = appFor(workflowsCollectionContract);
const automations = appFor(workflowAutomationsContract);
const workflowWebhook = appFor(webhookWorkflowAutomationContract);

function signWebhookDelivery(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
}

function setupTeamWorkflowContext() {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;

  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", `whsec_${randomUUID()}`);
  context.mocks.s3.send.mockResolvedValue({
    ContentLength: 1024,
    UploadId: randomUUID(),
    ETag: "fixture-etag",
  });

  async function deliverStripeEvent(event: Record<string, unknown>) {
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      stripeWebhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=webhook-automation-test" },
      }),
      [200],
    );
  }

  async function activateTeamPlan() {
    const end = Math.floor(now() / 1000) + 30 * DAY_SECONDS;
    const start = end - 30 * DAY_SECONDS;

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      status: "active",
      customer: customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: TEAM_PRICE },
            current_period_start: start,
            current_period_end: end,
          },
        ],
      },
    });

    await deliverStripeEvent({
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: {},
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                price: { id: TEAM_PRICE },
                quantity: 1,
                parent: { type: "subscription_item_details" },
                period: { start, end },
              },
            ],
          },
        },
      },
    });
  }

  return {
    customerId,
    subscriptionId,
    workflows,
    automations,
    workflowWebhook,
    activateTeamPlan,
    deliverStripeEvent,
  };
}

describe("POST /api/webhooks/workflow-automations/:token", () => {
  it("webhooks-workflow-automations-004 keeps webhooks enabled through a scheduled cancellation period", async () => {
    const {
      customerId,
      subscriptionId,
      workflows,
      automations,
      activateTeamPlan,
      deliverStripeEvent,
    } = setupTeamWorkflowContext();

    await activateTeamPlan();

    const createdWorkflow = await accept(
      workflows.create({
        headers: AUTH_HEADERS,
        body: {
          name: `cancel-period-wf-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    );

    const enabledCreated = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId: createdWorkflow.body.id },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [201],
    );

    const nowSec = Math.floor(now() / 1000);
    const periodEnd = nowSec + DAY_SECONDS;
    const periodStart = periodEnd - 30 * DAY_SECONDS;

    await deliverStripeEvent({
      id: `evt_${randomUUID()}`,
      created: nowSec,
      type: "customer.subscription.updated",
      data: {
        previous_attributes: {
          cancel_at_period_end: false,
        },
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          cancel_at_period_end: true,
          cancel_at: periodEnd,
          schedule: null,
          trial_end: null,
          metadata: {},
          items: {
            data: [
              {
                price: { id: TEAM_PRICE },
                current_period_start: periodStart,
                current_period_end: periodEnd,
              },
            ],
          },
        },
      },
    });

    const afterCancelScheduled = await accept(
      automations.get({
        headers: AUTH_HEADERS,
        params: { id: enabledCreated.body.id },
      }),
      [200],
    );
    expect(afterCancelScheduled.body).toMatchObject({
      enabled: true,
      disabledReason: null,
    });
  });

  it("webhooks-workflow-automations-003 auto-disables only enabled webhooks after an effective Stripe downgrade", async () => {
    const {
      customerId,
      subscriptionId,
      workflows,
      automations,
      workflowWebhook,
      activateTeamPlan,
      deliverStripeEvent,
    } = setupTeamWorkflowContext();

    await activateTeamPlan();

    const createdWorkflow = await accept(
      workflows.create({
        headers: AUTH_HEADERS,
        body: {
          name: `downgrade-wf-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    );
    const workflowId = createdWorkflow.body.id;

    const enabledCreated = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [201],
    );
    const enabledAutomation = enabledCreated.body;
    if (
      enabledAutomation.kind !== "event" ||
      enabledAutomation.eventType !== "webhook-received" ||
      !enabledAutomation.webhookUrl ||
      !enabledAutomation.webhookSecret
    ) {
      throw new Error("Expected enabled webhook-received automation");
    }

    const manualDisabledCreated = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "webhook-received",
        },
      }),
      [201],
    );
    const manualDisabledId = manualDisabledCreated.body.id;

    await accept(
      automations.disable({
        headers: AUTH_HEADERS,
        params: { id: manualDisabledId },
      }),
      [200],
    );

    await deliverStripeEvent({
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "canceled",
          metadata: {},
          items: {
            data: [{ price: { id: TEAM_PRICE } }],
          },
        },
      },
    });

    const enabledAfter = await accept(
      automations.get({
        headers: AUTH_HEADERS,
        params: { id: enabledAutomation.id },
      }),
      [200],
    );
    expect(enabledAfter.body).toMatchObject({
      enabled: false,
      disabledReason: "paid_plan_required",
    });

    const manualDisabledAfter = await accept(
      automations.get({
        headers: AUTH_HEADERS,
        params: { id: manualDisabledId },
      }),
      [200],
    );
    expect(manualDisabledAfter.body).toMatchObject({
      enabled: false,
      disabledReason: null,
    });

    const token = new URL(enabledAutomation.webhookUrl).pathname
      .split("/")
      .at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }
    const rawBody = JSON.stringify({ event: "after-downgrade" });
    const timestamp = Math.floor(now() / 1000);
    await accept(
      workflowWebhook.post({
        params: { token },
        body: rawBody,
        extraHeaders: {
          "content-type": "application/json",
          "x-okou-timestamp": String(timestamp),
          "x-okou-signature": signWebhookDelivery(
            rawBody,
            enabledAutomation.webhookSecret,
            timestamp,
          ),
        },
      }),
      [404],
    );
  });
});
