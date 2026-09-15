import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { modelProvidersByTypeContract } from "@okouai/api-contracts/contracts/model-provider-routes";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { modelProvidersRoutes } from "../model-providers";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksWorkflowAutomationsRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);

const WORKFLOW_NAME = "webhook-automation-workflow";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function modelProvidersByTypeClient() {
  return setupApp({ context, routes: modelProvidersRoutes })(
    modelProvidersByTypeContract,
  );
}

interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

async function setupFixture(): Promise<{
  readonly fixture: WorkflowsFixture;
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly subscriptionId: string;
}> {
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const { actor, subscriptionId } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Webhook Automation Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  const fixture = { orgId: actor.orgId, userId: actor.userId };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
  context.mocks.s3.send.mockResolvedValue({});
  return {
    fixture,
    actor,
    agentId: agent.agentId,
    workflowId,
    subscriptionId,
  };
}

async function createWebhookAutomation(workflowId: string): Promise<{
  readonly id: string;
  readonly token: string;
  readonly webhookUrl: string;
  readonly secret: string;
}> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  if (
    created.body.kind !== "event" ||
    created.body.eventType !== "webhook-received" ||
    !created.body.webhookUrl ||
    !created.body.webhookSecret
  ) {
    throw new Error("Expected a webhook automation with a one-time secret");
  }
  const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
  if (!token) {
    throw new Error("Expected webhook URL token");
  }
  return {
    id: created.body.id,
    token,
    webhookUrl: created.body.webhookUrl,
    secret: created.body.webhookSecret,
  };
}

async function postWorkflowWebhook(args: {
  readonly token: string;
  readonly rawBody: string;
  readonly secret: string;
  readonly timestamp?: number;
  readonly signature?: string;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const timestamp = args.timestamp ?? Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(`/api/webhooks/workflow-automations/${args.token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Okou-Timestamp": String(timestamp),
      "X-Okou-Signature":
        args.signature ??
        computeHmacSignature(args.rawBody, args.secret, timestamp),
    },
    body: args.rawBody,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe("POST /api/webhooks/workflow-automations/:token", () => {
  it("dispatches signed webhook deliveries and de-duplicates retries", async () => {
    const { workflowId } = await setupFixture();
    const runsApi = createRunsApi(context);
    const runnerGroup = runsApi.configureRunnerGroup();
    const webhook = await createWebhookAutomation(workflowId);
    expect(new URL(webhook.webhookUrl).pathname).toBe(
      `/api/webhooks/workflow-automations/${webhook.token}`,
    );

    const rawBody = JSON.stringify({
      event: "okou-timing-sensitive-ping",
      value: "okou-timing-secret-value",
    });
    const timestamp = Math.floor(now() / 1000);
    const first = await postWorkflowWebhook({
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    });

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      duplicate: false,
      runId: expect.any(String),
    });
    if (
      typeof first.body !== "object" ||
      first.body === null ||
      !("runId" in first.body) ||
      typeof first.body.runId !== "string"
    ) {
      throw new Error("Expected webhook dispatch response to include runId");
    }

    await runsApi.heartbeatRunner(runnerGroup);
    const workflowClaim = await runsApi.claimRunnerJob(first.body.runId);
    const workflowPrompt = workflowClaim.appendSystemPrompt ?? "";
    expect(workflowPrompt).toContain("okou slack message send --help");
    expect(workflowPrompt).not.toContain(
      "normal replies are automatically sent to the originating thread",
    );
    expect(workflowPrompt).not.toContain("Never use SLACK_TOKEN directly");

    const second = await postWorkflowWebhook({
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    });

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      duplicate: true,
    });
    // The duplicate retry does not enqueue a second runner job.
    const idleAfterDuplicate = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterDuplicate.body.job).toBeNull();

    const concurrentRawBody = JSON.stringify({
      event: "concurrent-dedupe",
      value: "same-delivery",
    });
    const concurrent = await Promise.all([
      postWorkflowWebhook({
        token: webhook.token,
        rawBody: concurrentRawBody,
        secret: webhook.secret,
        timestamp,
      }),
      postWorkflowWebhook({
        token: webhook.token,
        rawBody: concurrentRawBody,
        secret: webhook.secret,
        timestamp,
      }),
    ]);
    expect(concurrent).toStrictEqual(
      expect.arrayContaining([
        {
          status: 200,
          body: { success: true, duplicate: false },
        },
        {
          status: 200,
          body: { success: true, duplicate: true },
        },
      ]),
    );
    expect(concurrent).toHaveLength(2);
  });

  it("deletes a failed delivery so an identical request can retry", async () => {
    const { actor, fixture, workflowId } = await setupFixture();
    const runsApi = createRunsApi(context);
    const webhook = await createWebhookAutomation(workflowId);
    const rawBody = JSON.stringify({ event: "retry-after-dispatch-failure" });
    const timestamp = Math.floor(now() / 1000);

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await accept(
      modelProvidersByTypeClient().delete({
        headers: authHeaders(),
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );
    const failed = await postWorkflowWebhook({
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    });
    expect(failed).toStrictEqual({
      status: 500,
      body: { error: "Failed to start webhook workflow run" },
    });

    await runsApi.ensureOrgModelProvider(actor);
    const retried = await postWorkflowWebhook({
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    });
    expect(retried).toStrictEqual({
      status: 200,
      body: {
        success: true,
        duplicate: false,
        runId: expect.any(String),
      },
    });

    const duplicate = await postWorkflowWebhook({
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    });
    expect(duplicate).toStrictEqual({
      status: 200,
      body: { success: true, duplicate: true },
    });
  });

  it("auto-disables only enabled webhooks after an effective Stripe downgrade", async () => {
    const { fixture, workflowId, subscriptionId } = await setupFixture();
    const enabled = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (
      enabled.body.kind !== "event" ||
      enabled.body.eventType !== "webhook-received" ||
      !enabled.body.webhookUrl ||
      !enabled.body.webhookSecret
    ) {
      throw new Error("Expected a webhook automation with credentials");
    }
    const manuallyDisabled = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: manuallyDisabled.body.id },
        body: undefined,
      }),
      [200],
    );

    const stripeApi = createWebhookCallbackApi(context);
    await stripeApi.postStripeEvent(
      {
        id: `evt_webhook_downgrade_${fixture.orgId}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId } },
      },
      [200],
    );

    const enabledAfter = await wf.readAutomation(enabled.body.id);
    expect(enabledAfter).toMatchObject({
      enabled: false,
      disabledReason: "paid_plan_required",
    });
    const manualAfter = await wf.readAutomation(manuallyDisabled.body.id);
    expect(manualAfter.enabled).toBeFalsy();
    if (
      manualAfter.kind !== "event" ||
      manualAfter.eventType !== "webhook-received"
    ) {
      throw new Error("Expected a webhook automation");
    }
    expect(manualAfter.disabledReason).toBeNull();
    const token = new URL(enabled.body.webhookUrl).pathname.split("/").at(-1);
    if (!token) {
      throw new Error("Expected webhook URL token");
    }
    const response = await postWorkflowWebhook({
      token,
      rawBody: JSON.stringify({ event: "after-downgrade" }),
      secret: enabled.body.webhookSecret,
    });
    expect(response.status).toBe(404);
  });

  it("keeps webhooks enabled through a scheduled cancellation period", async () => {
    const { fixture, workflowId, subscriptionId } = await setupFixture();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const stripeApi = createWebhookCallbackApi(context);
    await stripeApi.postStripeEvent(
      {
        id: `evt_webhook_cancel_scheduled_${fixture.orgId}`,
        type: "customer.subscription.updated",
        data: {
          object: {
            id: subscriptionId,
            status: "active",
            cancel_at_period_end: true,
            items: {
              data: [
                {
                  price: { id: "price_bdd_team" },
                  current_period_end: Math.floor(now() / 1000) + 86_400,
                },
              ],
            },
          },
          previous_attributes: { cancel_at_period_end: false },
        },
      },
      [200],
    );

    const after = await wf.readAutomation(created.body.id);
    expect(after.enabled).toBeTruthy();
    if (after.kind !== "event" || after.eventType !== "webhook-received") {
      throw new Error("Expected a webhook automation");
    }
    expect(after.disabledReason).toBeNull();
  });
});
