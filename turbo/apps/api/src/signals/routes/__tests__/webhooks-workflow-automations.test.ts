import { createHmac, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  webhookCompleteContract,
  webhookStripeContract,
  webhookWorkflowAutomationContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runnersRoutes } from "../runners";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const DAY_SECONDS = 86_400;
const CLAUDE_MODEL = "claude-fable-5-1";

const appFor = setupApp({
  context,
  routes: [
    ...webhooksStripeRoutes,
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
    ...webhooksWorkflowAutomationsRoutes,
    ...chatThreadRoutes,
    ...meModelProvidersUpsertRoutes,
    ...runnersRoutes,
    ...userModelPreferenceRoutes,
    ...webhooksAgentCompleteRoutes,
  ],
});
const stripeWebhook = appFor(webhookStripeContract);
const workflows = appFor(workflowsCollectionContract);
const automations = appFor(workflowAutomationsContract);
const workflowWebhook = appFor(webhookWorkflowAutomationContract);
const chatThreadEventsApi = appFor(chatThreadEventsContract);
const personalModelProvidersApi = appFor(personalModelProvidersMainContract);
const runnersHeartbeatApi = appFor(runnersHeartbeatContract);
const userModelPreferenceApi = appFor(userModelPreferenceContract);
const webhooksAgentCompleteApi = appFor(webhookCompleteContract);

function signWebhookDelivery(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
}

function setupTeamWorkflowContext(actor?: {
  readonly userId: string;
  readonly orgId: string;
}) {
  const orgId = actor?.orgId ?? `org_${randomUUID()}`;
  const userId = actor?.userId ?? `user_${randomUUID()}`;
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
  const bdd = createBddApi(context);
  const runsApi = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(
          workflows.create({
            headers: {},
            body: { name: "warmup-hook", visibility: "private" },
          }),
          [401],
        ),
        accept(
          automations.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          chatThreadEventsApi.catchUp({
            headers: {},
            body: [[warmupId, 0]],
          }),
          [401],
        ),
        accept(
          personalModelProvidersApi.upsert({
            headers: {},
            body: { type: "claude-code-oauth-token", secret: "warmup" },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: {},
            body: {
              runnerId: warmupId,
              runnerHostname: `runner-${warmupId}.okou.app`,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 8,
              totalMemoryMb: 16_384,
              maxConcurrent: 2,
              allocatedVcpu: 0,
              allocatedMemoryMb: 0,
              runningCount: 0,
              admittableProfiles: ["vm0/default"],
              heldSandboxStates: [],
              heldHomeStates: [],
              activeReuseProducers: [],
              mode: "running",
              ingressServiceActive: true,
            },
          }),
          [401],
        ),
        accept(
          userModelPreferenceApi.update({
            headers: {},
            body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
          }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        bdd.requestReadMe(null, [401]),
      ]);
      runnerDispatchEnvelopeSchema.safeParse({});
    });
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

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

  it(
    "webhooks-workflow-automations-001 dispatches signed webhook deliveries and de-duplicates retries",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const group = `vm0/webhook-auto-${randomUUID().slice(0, 8)}`;
      const runnerId = randomUUID();
      const hostname = `runner-${runnerId}.okou.app`;
      const acceptedOrder: string[] = [];
      const acceptedByRunId = new Map<string, ExecutionContext>();
      const completedRunIds = new Set<string>();
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const kmsKey = env("SECRETS_KMS_KEY_ID");

      const actor: ApiTestUser = bdd.user({ orgRole: "org:admin" });
      if (!actor.orgId) {
        throw new Error("Expected org-scoped actor");
      }
      const actorOrgId = actor.orgId;
      const cleanupState: { automationId?: string } = {};

      function authenticateMember() {
        createRouteMocks(context).clerk.session(
          actor.userId,
          actorOrgId,
          "org:admin",
        );
        const emailId = `email_${actor.userId}`;
        mockClerkUsers(context, [
          {
            id: actor.userId,
            emailAddresses: [{ id: emailId, emailAddress: actor.email }],
            primaryEmailAddressId: emailId,
            firstName: "BDD",
            lastName: "Webhook",
          },
        ]);
        return AUTH_HEADERS;
      }

      chatCallbacks.acceptChatObjectStorage();
      runsApi.acceptStorageDownloads();
      runsApi.acceptTelemetryIngest();
      chatCallbacks.disableVapid();
      mockClaudeCodeTokenEndpoint();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);

      server.use(
        http.post(
          `https://${hostname}/runners/${runnerId}/control/runs/:runId/dispatch`,
          async ({ request, params }) => {
            const encoding = request.headers.get("content-encoding");
            const rawBytes = Buffer.from(await request.arrayBuffer());
            const text =
              encoding === "gzip"
                ? gunzipSync(rawBytes).toString("utf8")
                : rawBytes.toString("utf8");
            const envelope = runnerDispatchEnvelopeSchema.parse(
              JSON.parse(text),
            );
            if (
              envelope.runnerId !== runnerId ||
              envelope.executionContext.runId !== params.runId
            ) {
              throw new Error("Unexpected direct Runner dispatch identity");
            }
            acceptedByRunId.set(
              envelope.executionContext.runId,
              envelope.executionContext,
            );
            acceptedOrder.push(envelope.executionContext.runId);
            return HttpResponse.json({
              runnerId,
              heartbeatGeneration: 1,
              runId: envelope.executionContext.runId,
              disposition: "accepted",
            });
          },
        ),
      );

      onTestFinished(async () => {
        const previousGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
        mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
        mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
        context.mocks.ably.publish.mockResolvedValue(undefined);
        context.mocks.s3.getSignedUrl.mockImplementation(
          (_client: unknown, command: unknown) => {
            return Promise.resolve(apiTestS3PresignedUrl(command));
          },
        );
        const cleaned = await settleIncludingAbort(async () => {
          await flushWaitUntilForTest();
          if (cleanupState.automationId) {
            await accept(
              automations.delete({
                headers: authenticateMember(),
                params: { id: cleanupState.automationId },
                body: undefined,
              }),
              [204, 404],
            );
            await flushWaitUntilForTest();
          }
          for (const runId of acceptedOrder) {
            if (completedRunIds.has(runId)) {
              continue;
            }
            const exec = acceptedByRunId.get(runId);
            if (!exec) {
              continue;
            }
            await accept(
              webhooksAgentCompleteApi.complete({
                headers: { authorization: `Bearer ${exec.sandboxToken}` },
                body: {
                  runId,
                  exitCode: 0,
                  completion: {
                    cliAgentType: "claude-code",
                    cliAgentSessionId: `complete-${runId}`,
                    cliAgentSessionHistoryDisposition: "native_only",
                    storageOutputs: [],
                  },
                },
              }),
              [200],
            );
            completedRunIds.add(runId);
          }
          await flushWaitUntilForTest();
        });
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousGroup);
        if (!cleaned.ok) {
          throw cleaned.error;
        }
      });

      await bdd.provisionWorkspace(actor);
      const { activateTeamPlan } = setupTeamWorkflowContext({
        userId: actor.userId,
        orgId: actorOrgId,
      });
      chatCallbacks.acceptChatObjectStorage();
      authenticateMember();

      const [createdWorkflow] = await Promise.all([
        accept(
          workflows.create({
            headers: AUTH_HEADERS,
            body: {
              name: `webhook-dedup-wf-${randomUUID().slice(0, 8)}`,
              visibility: "private",
            },
          }),
          [201],
        ),
        activateTeamPlan(),
        bdd.completeOnboarding(actor),
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: {
              authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
            },
            body: {
              runnerId,
              runnerHostname: hostname,
              group,
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 16,
              totalMemoryMb: 32_768,
              maxConcurrent: 4,
              allocatedVcpu: 0,
              allocatedMemoryMb: 0,
              runningCount: 0,
              admittableProfiles: ["vm0/default"],
              heldSandboxStates: [],
              heldHomeStates: [],
              activeReuseProducers: [],
              mode: "running",
              ingressServiceActive: true,
            },
          }),
          [200],
        ),
        accept(
          personalModelProvidersApi.upsert({
            headers: AUTH_HEADERS,
            body: {
              type: "claude-code-oauth-token",
              secret: `sk-ant-oat01-${randomUUID()}`,
            },
          }),
          [201],
        ),
      ]);

      await accept(
        userModelPreferenceApi.update({
          headers: AUTH_HEADERS,
          body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
        }),
        [200],
      );
      const createdAutomation = await accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId: createdWorkflow.body.id },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      const automation = createdAutomation.body;
      if (
        automation.kind !== "event" ||
        automation.eventType !== "webhook-received" ||
        !automation.webhookUrl ||
        !automation.webhookSecret ||
        !automation.chatThreadId
      ) {
        throw new Error("Expected webhook-received automation with URL/secret");
      }
      cleanupState.automationId = automation.id;

      const parsedUrl = new URL(automation.webhookUrl);
      const token = parsedUrl.pathname.split("/").at(-1);
      if (!token) {
        throw new Error("Expected webhook URL token");
      }
      expect(parsedUrl.pathname).toBe(
        `/api/webhooks/workflow-automations/${token}`,
      );

      const firstBody = JSON.stringify({ event: "deploy", version: 1 });
      const firstTimestamp = Math.floor(now() / 1000);
      const firstHeaders = {
        "content-type": "application/json",
        "x-okou-timestamp": String(firstTimestamp),
        "x-okou-signature": signWebhookDelivery(
          firstBody,
          automation.webhookSecret,
          firstTimestamp,
        ),
      };

      const firstResponse = await accept(
        workflowWebhook.post({
          params: { token },
          body: firstBody,
          extraHeaders: firstHeaders,
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(firstResponse.body).toStrictEqual({
        success: true,
        duplicate: false,
      });
      expect(acceptedOrder).toHaveLength(1);
      const firstRunId = acceptedOrder[0] ?? "";
      const firstExec = acceptedByRunId.get(firstRunId);
      expect(firstExec?.appendSystemPrompt).toContain(
        "okou slack message send --help",
      );
      expect(firstExec?.appendSystemPrompt).not.toContain(
        "Never use SLACK_TOKEN directly",
      );

      const retryResponse = await accept(
        workflowWebhook.post({
          params: { token },
          body: firstBody,
          extraHeaders: firstHeaders,
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(retryResponse.body).toStrictEqual({
        success: true,
        duplicate: true,
      });
      expect(acceptedOrder).toHaveLength(1);

      const secondBody = JSON.stringify({ event: "deploy", version: 2 });
      const secondTimestamp = firstTimestamp + 1;
      const secondHeaders = {
        "content-type": "application/json",
        "x-okou-timestamp": String(secondTimestamp),
        "x-okou-signature": signWebhookDelivery(
          secondBody,
          automation.webhookSecret,
          secondTimestamp,
        ),
      };
      const [concurrentA, concurrentB] = await Promise.all([
        accept(
          workflowWebhook.post({
            params: { token },
            body: secondBody,
            extraHeaders: secondHeaders,
          }),
          [200],
        ),
        accept(
          workflowWebhook.post({
            params: { token },
            body: secondBody,
            extraHeaders: secondHeaders,
          }),
          [200],
        ),
      ]);
      await flushWaitUntilForTest();

      const sortedConcurrent = concurrentA.body.duplicate
        ? [concurrentB.body, concurrentA.body]
        : [concurrentA.body, concurrentB.body];
      expect(sortedConcurrent).toStrictEqual([
        { success: true, duplicate: false },
        { success: true, duplicate: true },
      ]);

      const events = await readProjectedChatEvents(context, {
        threadId: automation.chatThreadId,
        headers: authenticateMember(),
      });
      const revokedIds = new Set(
        events.flatMap((event) => {
          return event.revokesEventId ? [event.revokesEventId] : [];
        }),
      );
      const unrevokedAutomationEvents = events.filter((event) => {
        return (
          event.eventType === "input.automation" && !revokedIds.has(event.id)
        );
      });
      expect(unrevokedAutomationEvents).toHaveLength(1);
    },
  );
});
