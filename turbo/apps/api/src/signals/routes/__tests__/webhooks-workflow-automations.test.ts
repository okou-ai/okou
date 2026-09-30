import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { modelProvidersByTypeContract } from "@okouai/api-contracts/contracts/model-provider-routes";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { stageLegacyChatThreadSelectedModelFixture } from "../../../test-fixtures/model-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
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
  // Webhook runs are claimed by the native Runner, so the org default is
  // Fable, which model policy keeps off Pi.
  const { actor, subscriptionId } = await wf.setupWorkflowOrg({
    tier: "team",
    model: "claude-fable-5-1",
  });
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
  readonly threadId: string;
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
  if (!created.body.chatThreadId) {
    throw new Error("Expected a thread-bound webhook automation");
  }
  return {
    id: created.body.id,
    threadId: created.body.chatThreadId,
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
  const body: unknown = await response.json();
  // The webhook enqueues and returns; the pick runs in the background.
  await flushWaitUntilForTest();
  return { status: response.status, body };
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

    expect(first).toStrictEqual({
      status: 200,
      body: { success: true, duplicate: false },
    });

    await runsApi.heartbeatRunner(runnerGroup);
    const job = (await runsApi.pollRunner(runnerGroup)).body.job;
    if (!job) {
      throw new Error("Expected the accepted delivery to launch a run");
    }
    const workflowClaim = await runsApi.claimRunnerJob(job.runId);
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
    const events = await wf.readThreadEvents(webhook.threadId);
    expect(
      events.filter((event) => {
        return (
          event.eventType === "input.automation" &&
          !events.some((replacement) => {
            return replacement.revokesEventId === event.id;
          })
        );
      }),
    ).toHaveLength(1);
  });

  it("accepts a delivery whose launch is rejected and de-duplicates its retry", async () => {
    const { fixture, actor, workflowId } = await setupFixture();
    const runsApi = createRunsApi(context);
    const runnerGroup = runsApi.configureRunnerGroup();
    const webhook = await createWebhookAutomation(workflowId);
    const timestamp = Math.floor(now() / 1000);
    await expect(
      postWorkflowWebhook({
        token: webhook.token,
        rawBody: JSON.stringify({ event: "occupy-thread" }),
        secret: webhook.secret,
        timestamp,
      }),
    ).resolves.toStrictEqual({
      status: 200,
      body: { success: true, duplicate: false },
    });
    await runsApi.heartbeatRunner(runnerGroup);
    const job = (await runsApi.pollRunner(runnerGroup)).body.job;
    if (!job) {
      throw new Error("Expected the first delivery to occupy its thread");
    }

    // Capture the model while it is available; the occupied thread delays pick.
    const rawBody = JSON.stringify({ event: "launch-rejected" });
    const accepted = await postWorkflowWebhook({
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    });
    expect(accepted).toStrictEqual({
      status: 200,
      body: { success: true, duplicate: false },
    });
    const queuedEvents = await wf.readThreadEvents(webhook.threadId);
    const queued = queuedEvents.find((event) => {
      return (
        event.eventType === "input.automation" &&
        !queuedEvents.some((replacement) => {
          return replacement.revokesEventId === event.id;
        })
      );
    });
    if (!queued) {
      throw new Error("Expected the second delivery to remain queued");
    }

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await accept(
      modelProvidersByTypeClient().delete({
        headers: authHeaders(),
        params: { type: "anthropic-api-key" },
      }),
      [204],
    );
    await runsApi.requestCancelRun(actor, job.runId, [200]);
    await flushWaitUntilForTest();
    // The pick rejects the recorded model after it becomes unavailable.
    const rejectedEvents = await wf.readThreadEvents(webhook.threadId);
    expect(rejectedEvents).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: queued.id,
      }),
    );

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
    await expect(wf.readThreadEvents(webhook.threadId)).resolves.toStrictEqual(
      rejectedEvents,
    );
  });

  it("does not consume a delivery key when enqueue model selection fails", async () => {
    const { fixture, actor, workflowId } = await setupFixture();
    const runsApi = createRunsApi(context);
    runsApi.configureRunnerGroup();
    const webhook = await createWebhookAutomation(workflowId);
    const rawBody = JSON.stringify({ event: "restore-model-route" });
    const timestamp = Math.floor(now() / 1000);
    const delivery = {
      token: webhook.token,
      rawBody,
      secret: webhook.secret,
      timestamp,
    };
    // A legacy thread selection of a retired model resolves to its
    // replacement at enqueue. The workspace has no route for the replacement
    // (Opus 5.5 is not one of its policies), so capturing the input's model
    // fails explicitly instead of falling back to the system default.
    await stageLegacyChatThreadSelectedModelFixture({
      threadId: webhook.threadId,
      model: "claude-opus-4-8",
    });
    await expect(postWorkflowWebhook(delivery)).resolves.toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    await expect(wf.readThreadEvents(webhook.threadId)).resolves.toStrictEqual(
      [],
    );
    await expect(wf.readAutomation(webhook.id)).resolves.toMatchObject({
      lastReceivedAt: null,
    });

    // Adding a compatible route for the replacement lets the same delivery
    // be admitted: the failed attempt did not consume its key.
    await runsApi.ensureOrgModelProvider(actor, {
      model: "claude-opus-5-5",
    });
    await expect(postWorkflowWebhook(delivery)).resolves.toStrictEqual({
      status: 200,
      body: { success: true, duplicate: false },
    });
    const acceptedEvents = await wf.readThreadEvents(webhook.threadId);
    expect(acceptedEvents).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        runId: expect.any(String),
      }),
    );
    await expect(postWorkflowWebhook(delivery)).resolves.toStrictEqual({
      status: 200,
      body: { success: true, duplicate: true },
    });
    await expect(wf.readThreadEvents(webhook.threadId)).resolves.toStrictEqual(
      acceptedEvents,
    );
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
