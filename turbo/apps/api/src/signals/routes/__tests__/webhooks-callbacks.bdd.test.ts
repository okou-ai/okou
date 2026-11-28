import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookStripeContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { setupRawAppRequestWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { chatEventsRoutes } from "../chat-events";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runModelsRoutes } from "../run-models";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { sharedThreadRoutes } from "../shared-threads";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { webhooksAgentSessionOutputRoutes } from "../webhooks-agent-session-output";
import { webhooksAgentStorageRoutes } from "../webhooks-agent-storage";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { mockClerkUsers } from "./helpers/clerk-users";
import { memoryArchive } from "./helpers/public-runner-memory";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;
const ATOM_GRANT_PRICE = "price_bdd_atom_grant";

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function nowSeconds(): number {
  return Math.floor(now() / 1000);
}

function addOneMonthIso(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString();
}

function stripeEvent(
  type: string,
  object: Readonly<Record<string, unknown>>,
  previousAttributes?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    id: stripeId("evt"),
    type,
    created: nowSeconds(),
    data: {
      object,
      ...(previousAttributes === undefined
        ? {}
        : { previous_attributes: previousAttributes }),
    },
  };
}

function subscriptionInvoiceObject(args: {
  readonly id?: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly priceId: string | null;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly subscriptionMetadata?: Readonly<Record<string, string>>;
}): Readonly<Record<string, unknown>> {
  return {
    id: args.id ?? stripeId("in"),
    customer: args.customerId,
    metadata: {},
    subtotal: 0,
    parent: {
      subscription_details: {
        subscription: args.subscriptionId,
        metadata: args.subscriptionMetadata ?? {},
      },
    },
    lines: {
      has_more: false,
      data:
        args.priceId === null
          ? []
          : [
              {
                id: stripeId("il"),
                price: { id: args.priceId },
                quantity: 1,
                parent: { type: "subscription_item_details" },
                period: { start: args.periodStart, end: args.periodEnd },
              },
            ],
    },
  };
}

function stripeSubscriptionObject(args: {
  readonly id: string;
  readonly customerId: string;
  readonly priceId: string;
  readonly status?: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly trialEnd?: number | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: number | null;
  readonly scheduleId?: string | null;
  readonly quantity?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly discounts?: readonly { readonly id: string }[];
  readonly recurring?: {
    readonly interval: "month" | "year";
    readonly interval_count: number;
  };
}): Readonly<Record<string, unknown>> {
  return {
    id: args.id,
    object: "subscription",
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: args.cancelAt ?? null,
    schedule: args.scheduleId ?? null,
    trial_end: args.trialEnd ?? null,
    metadata: args.metadata ?? {},
    ...(args.discounts === undefined ? {} : { discounts: args.discounts }),
    items: {
      data: [
        {
          id: stripeId("si"),
          price: {
            id: args.priceId,
            ...(args.recurring === undefined
              ? {}
              : { recurring: args.recurring }),
          },
          quantity: args.quantity ?? 1,
          current_period_start: args.periodStart,
          current_period_end: args.periodEnd,
        },
      ],
    },
  };
}

describe("webhooks-callbacks.bdd", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const billing = createBillingMediaApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const chatFiles = createChatFilesBddApi(context);
  const runs = createRunsApi(context);
  const workflows = createWorkflowsBddApi(context);
  const routeMocks = createRouteMocks(context);

  const SESSION_HEADERS = Object.freeze({
    authorization: "Bearer clerk-session",
  });
  const CLAUDE_MODEL = "claude-fable-5-1";

  const billingStatusApi = setupApp({
    context,
    routes: billingStatusRoutes,
  })(billingStatusContract);
  const billingUsagePackCreditsApi = setupApp({
    context,
    routes: billingUsagePackCreditsRoutes,
  })(billingUsagePackCreditsContract);
  const voiceIoQuotaApi = setupApp({
    context,
    routes: voiceIoQuotaRoutes,
  })(voiceIoQuotaContract);
  const workflowAutomationsApi = setupApp({
    context,
    routes: workflowAutomationsRoutes,
  })(workflowAutomationsContract);
  const chatEventsApi = setupApp({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const personalModelProvidersApi = setupApp({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const runModelsApi = setupApp({
    context,
    routes: runModelsRoutes,
  })(runModelsMainContract);
  const runnersHeartbeatApi = setupApp({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const runsByIdApi = setupApp({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runsQueueApi = setupApp({
    context,
    routes: runsRoutes,
  })(runsQueueContract);
  const runsCancelApi = setupApp({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const sharedThreadsApi = setupApp({
    context,
    routes: sharedThreadRoutes,
  })(sharedThreadsContract);
  const webhooksClerkApi = setupApp({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const webhooksStripeApi = setupApp({
    context,
    routes: webhooksStripeRoutes,
  })(webhookStripeContract);
  const webhooksAgentCompleteApi = setupApp({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhooksAgentEventsApi = setupApp({
    context,
    routes: webhooksAgentEventsRoutes,
  })(webhookEventsContract);
  const webhooksAgentHeartbeatApi = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookHeartbeatContract);
  const webhooksAgentTelemetryApi = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookTelemetryContract);
  const webhooksAgentUsageEventApi = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookUsageEventContract);
  const webhooksAgentStoragePrepareApi = setupApp({
    context,
    routes: webhooksAgentStorageRoutes,
  })(webhookStoragesPrepareContract);
  const webhooksAgentStorageCommitApi = setupApp({
    context,
    routes: webhooksAgentStorageRoutes,
  })(webhookStoragesCommitContract);
  const webhooksAgentSessionOutputRaw = setupRawAppRequestWithRoutes({
    context,
    routes: webhooksAgentSessionOutputRoutes,
  });

  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(webhooksStripeApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(billingStatusApi.get({ headers: {} }), [401]),
        accept(billingUsagePackCreditsApi.get({ headers: {} }), [401]),
        accept(voiceIoQuotaApi.get({ headers: {} }), [401]),
        accept(
          workflowAutomationsApi.get({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(runModelsApi.list({ headers: {} }), [401]),
        accept(
          chatEventsApi.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              clientEventId: randomUUID(),
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
            },
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
          runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(runsQueueApi.getQueue({ headers: {} }), [401]),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          sharedThreadsApi.create({
            headers: {},
            params: { threadId: warmupId },
            body: { eventIds: [warmupId] },
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
        accept(
          webhooksAgentEventsApi.send({
            headers: {},
            body: {
              runId: warmupId,
              events: [{ type: "system", sequenceNumber: 1, rawData: {} }],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentHeartbeatApi.send({
            headers: {},
            body: { runId: warmupId },
          }),
          [401],
        ),
        accept(
          webhooksAgentUsageEventApi.send({
            headers: {},
            body: {
              runId: warmupId,
              events: [
                {
                  idempotencyKey: warmupId,
                  kind: "model",
                  provider: "anthropic",
                  category: "input_tokens",
                  quantity: 1,
                },
              ],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentStoragePrepareApi.prepare({
            headers: {},
            body: { runId: warmupId, storageId: warmupId, files: [] },
          }),
          [401],
        ),
        accept(
          webhooksAgentStorageCommitApi.commit({
            headers: {},
            body: {
              runId: warmupId,
              storageId: warmupId,
              versionId: "warmup",
              files: [],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentSessionOutputRaw("/api/webhooks/run/session-output", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          [400],
        ),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  function sandboxHeaders(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  function signInWithProfile(actor: ApiTestUser): void {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
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
    const memberships = actor.orgId
      ? [
          {
            id: `membership-${actor.userId}-${actor.orgId}`,
            createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
            role: actor.orgRole ?? "org:admin",
            organization: { id: actor.orgId },
            publicUserData: { userId: actor.userId },
          },
        ]
      : [];
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: memberships,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: memberships },
    );
  }

  async function readRunModels(actor: ApiTestUser) {
    signInWithProfile(actor);
    const response = await accept(
      runModelsApi.list({ headers: SESSION_HEADERS }),
      [200],
    );
    return response.body;
  }

  async function readRunQueue(actor: ApiTestUser) {
    signInWithProfile(actor);
    const response = await accept(
      runsQueueApi.getQueue({ headers: SESSION_HEADERS }),
      [200],
    );
    return response.body;
  }

  interface TrackedSandboxRun {
    readonly actor: ApiTestUser;
    readonly runId: string;
    readonly sandboxToken: string;
    done: boolean;
  }

  function createDirectRunnerForRunTests(
    group = `vm0/whcb-${randomUUID().slice(0, 8)}`,
  ) {
    const runnerId = randomUUID();
    const hostname = `runner-${runnerId}.okou.app`;
    const acceptedOrder: string[] = [];
    const acceptedByRunId = new Map<string, ExecutionContext>();
    const tracked: TrackedSandboxRun[] = [];
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const capturedNowMs = now();

    chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
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
          const envelope = runnerDispatchEnvelopeSchema.parse(JSON.parse(text));
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
      mockNow(capturedNowMs);
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
        const active = tracked.filter((entry) => {
          return !entry.done;
        });
        if (active.length > 0) {
          await Promise.all(
            active.map(async (entry) => {
              await accept(
                webhooksAgentCompleteApi.complete({
                  headers: sandboxHeaders(entry.sandboxToken),
                  body: {
                    runId: entry.runId,
                    exitCode: 0,
                    completion: {
                      cliAgentType: "claude-code",
                      cliAgentSessionId: `cleanup-${entry.runId}`,
                      cliAgentSessionHistoryDisposition: "native_only",
                      storageOutputs: [],
                    },
                  },
                }),
                [200],
              );
              entry.done = true;
            }),
          );
        }
        await flushWaitUntilForTest();
      });
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousGroup);
      if (!cleaned.ok) {
        throw cleaned.error;
      }
    });

    async function registerRunner(): Promise<void> {
      await accept(
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
            totalVcpu: 32,
            totalMemoryMb: 65_536,
            maxConcurrent: 10,
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
      );
    }

    async function addClaudeProvider(actor: ApiTestUser): Promise<void> {
      signInWithProfile(actor);
      await accept(
        personalModelProvidersApi.upsert({
          headers: SESSION_HEADERS,
          body: {
            type: "claude-code-oauth-token",
            secret: `claude-token-${randomUUID()}`,
          },
        }),
        [201],
      );
    }

    async function sendChatInput(
      actor: ApiTestUser,
      args: {
        readonly prompt: string;
        readonly threadId?: string;
        readonly model?: string | null;
      },
    ) {
      signInWithProfile(actor);
      const clientEventId = randomUUID();
      const sent = await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            prompt: args.prompt,
            hasTextContent: true,
            clientEventId,
            ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
            ...(args.model === undefined ? {} : { model: args.model }),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: args.prompt }],
            },
          },
        }),
        [201],
      );
      return {
        threadId: sent.body.threadId,
        clientEventId,
      };
    }

    function trackExecution(
      actor: ApiTestUser,
      execution: ExecutionContext,
    ): TrackedSandboxRun {
      const existing = tracked.find((entry) => {
        return entry.runId === execution.runId;
      });
      if (existing) {
        return existing;
      }
      const entry: TrackedSandboxRun = {
        actor,
        runId: execution.runId,
        sandboxToken: execution.sandboxToken,
        done: false,
      };
      tracked.push(entry);
      return entry;
    }

    async function launchRun(
      actor: ApiTestUser,
      args: {
        readonly prompt: string;
        readonly threadId?: string;
        readonly model?: string | null;
      },
    ) {
      const before = acceptedOrder.length;
      const sent = await sendChatInput(actor, args);
      await flushWaitUntilForTest();
      const runId = acceptedOrder[before];
      if (!runId) {
        throw new Error("Expected a Runner dispatch for chat run");
      }
      const execution = acceptedByRunId.get(runId);
      if (!execution) {
        throw new Error(`Missing execution context for ${runId}`);
      }
      const trackedEntry = trackExecution(actor, execution);
      return {
        threadId: sent.threadId,
        clientEventId: sent.clientEventId,
        runId,
        execution,
        trackedEntry,
      };
    }

    async function launchRunsParallel(
      actor: ApiTestUser,
      prompts: readonly string[],
      model: string = CLAUDE_MODEL,
    ) {
      const before = acceptedOrder.length;
      const sentList = await Promise.all(
        prompts.map((prompt) => {
          return sendChatInput(actor, { prompt, model });
        }),
      );
      await flushWaitUntilForTest();
      const newIds = acceptedOrder.slice(before);
      if (newIds.length !== prompts.length) {
        throw new Error(
          `Expected ${prompts.length} dispatched runs, observed ${newIds.length}`,
        );
      }
      return newIds.map((runId, index) => {
        const execution = acceptedByRunId.get(runId);
        if (!execution) {
          throw new Error(`Missing execution context for ${runId}`);
        }
        const trackedEntry = trackExecution(actor, execution);
        return {
          threadId: sentList[index]?.threadId ?? "",
          clientEventId: sentList[index]?.clientEventId ?? "",
          runId,
          execution,
          trackedEntry,
        };
      });
    }

    return {
      acceptedOrder,
      acceptedByRunId,
      registerRunner,
      addClaudeProvider,
      sendChatInput,
      trackExecution,
      launchRun,
      launchRunsParallel,
    };
  }

  async function readUsagePackCredits(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const response = await accept(
      billingUsagePackCreditsApi.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    return response.body;
  }

  async function readVoiceQuota(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const response = await accept(
      voiceIoQuotaApi.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    return response.body;
  }

  async function createLoopAndWebhookAutomations(
    actor: ApiTestUser,
    workflowId: string,
  ): Promise<{ readonly loopId: string; readonly webhookId: string }> {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const [loopCreated, webhookCreated] = await Promise.all([
      accept(
        workflowAutomationsApi.create({
          headers,
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 3600 },
          },
        }),
        [201],
      ),
      accept(
        workflowAutomationsApi.create({
          headers,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      ),
    ]);
    return { loopId: loopCreated.body.id, webhookId: webhookCreated.body.id };
  }

  async function readAutomationAs(actor: ApiTestUser, automationId: string) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const response = await accept(
      workflowAutomationsApi.get({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: automationId },
      }),
      [200],
    );
    return response.body;
  }

  it("webhooks-callbacks.bdd-002 rejects Stripe requests with missing or invalid signatures", async () => {
    webhooks.configureStripeBillingEnv();

    const missing = await webhooks.requestStripeWebhook("{}", {}, [401]);
    expect(missing.body).toStrictEqual({
      error: "Missing stripe-signature header",
    });

    webhooks.rejectNextStripeWebhookSignature();
    const invalid = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "t=1,v1=invalid" },
      [401],
    );
    expect(invalid.body).toStrictEqual({ error: "Invalid webhook signature" });

    webhooks.acceptNextStripeWebhookEvent(
      stripeEvent("charge.succeeded", { id: stripeId("ch") }),
    );
    const signed = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "t=1,v1=valid" },
      [200],
    );
    expect(signed.body).toBe("OK");
  });

  it("webhooks-callbacks.bdd-004 rejects Clerk requests when webhook verification is missing or invalid", async () => {
    webhooks.configureClerkWebhookSecret();

    webhooks.rejectNextClerkWebhookVerification();
    const noHeaders = await webhooks.requestClerkWebhook("{}", {}, [401]);
    expect(noHeaders.body).toStrictEqual({
      error: "Invalid webhook signature",
    });

    webhooks.rejectNextClerkWebhookVerification();
    const badSig = await webhooks.requestClerkWebhook(
      "{}",
      {
        "svix-id": "msg_bad",
        "svix-timestamp": String(nowSeconds()),
        "svix-signature": "v1,invalid",
      },
      [401],
    );
    expect(badSig.body).toStrictEqual({ error: "Invalid webhook signature" });
  });

  it("webhooks-callbacks.bdd-007 keeps Clerk membership creation from duplicating bootstrap state", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    await deliverOrganizationCreated(context, admin);

    const personalBefore = await readUsagePackCredits(admin);
    expect(personalBefore.bonusCredits).toBe(1000);
    expect(personalBefore.creditGrants).toHaveLength(1);

    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.created",
      data: {
        organization: { id: orgId },
        public_user_data: { user_id: admin.userId },
        created_at: now(),
      },
    });
    const delivered = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(delivered.body).toBe("OK");
    await flushWaitUntilForTest();

    const status = await billing.readBillingStatus(admin);
    expect(status).toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      creditGrants: [],
      onboardingPaymentPending: false,
    });

    const personalAfter = await readUsagePackCredits(admin);
    expect(personalAfter).toStrictEqual(personalBefore);

    const onboarding = await bdd.readOnboardingStatus(admin);
    expect(onboarding).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
    });
  });

  it("webhooks-callbacks.bdd-008 rejects GitHub requests with missing headers or invalid signatures", async () => {
    webhooks.configureGithubWebhookSecret();

    const missing = await webhooks.requestGithubWebhook("{}", {}, [401]);
    expect(missing.body).toStrictEqual({
      error: "Missing GitHub webhook headers",
    });

    const badSig = await webhooks.requestGithubWebhook(
      "{}",
      {
        "x-github-delivery": "delivery-bad",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      [401],
    );
    expect(badSig.body).toStrictEqual({ error: "Invalid signature" });

    const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const ping = await webhooks.requestGithubWebhook(
      pingBody,
      webhooks.signedGithubWebhookHeaders(pingBody, "ping"),
      [200],
    );
    expect(ping.body).toStrictEqual({ message: "pong" });

    const forkBody = JSON.stringify({ action: "forked" });
    const fork = await webhooks.requestGithubWebhook(
      forkBody,
      webhooks.signedGithubWebhookHeaders(forkBody, "fork"),
      [200],
    );
    expect(fork.body).toBe("OK");
  });

  it("webhooks-callbacks.bdd-037 uses each successful card payment as the customer default", async () => {
    webhooks.configureStripeBillingEnv();
    const customerId = stripeId("cus");
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: {},
    });
    const updates: unknown[] = [];
    context.mocks.stripe.customers.update.mockImplementation(
      (id: unknown, payload: unknown) => {
        updates.push({ id, payload });
        return Promise.resolve({ id });
      },
    );

    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_bdd_card",
      type: "card",
      customer: customerId,
    });
    const cardRes = await webhooks.postStripeEvent(
      stripeEvent("payment_intent.succeeded", {
        id: stripeId("pi"),
        customer: customerId,
        payment_method: "pm_bdd_card",
        metadata: {},
      }),
      [200],
    );
    expect(cardRes.status).toBe(200);
    expect(updates).toStrictEqual([
      {
        id: customerId,
        payload: {
          invoice_settings: { default_payment_method: "pm_bdd_card" },
        },
      },
    ]);

    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_bdd_bank",
      type: "us_bank_account",
      customer: customerId,
    });
    const bankRes = await webhooks.postStripeEvent(
      stripeEvent("payment_intent.succeeded", {
        id: stripeId("pi"),
        customer: customerId,
        payment_method: "pm_bdd_bank",
        metadata: {},
      }),
      [200],
    );
    expect(bankRes.status).toBe(200);
    expect(updates).toStrictEqual([
      {
        id: customerId,
        payload: {
          invoice_settings: { default_payment_method: "pm_bdd_card" },
        },
      },
    ]);
  });

  it("webhooks-callbacks.bdd-038 keeps the normal credit window for a non-Atom early cancellation", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEndUnix = startSec + 30 * DAY_SECONDS;
    const cancelAtUnix = startSec + 7 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    await runs.grantProEntitlement(member, {
      periodEndUnix,
      cancelAtUnix,
    });

    const status = await billing.readBillingStatus(member);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(
      new Date(cancelAtUnix * 1000).toISOString(),
    );
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        amount: 20_000,
        expiresAt: addOneMonthIso(periodEndUnix),
      }),
    ]);
  });

  it("webhooks-callbacks.bdd-039 (1/2) ignores entitlement redelivery, moves period on stale invoices, and grants renewals", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    const { customerId, subscriptionId, invoiceId } =
      await runs.grantProEntitlement(member, {
        periodEndUnix: startSec + 30 * DAY_SECONDS,
      });

    const mockSub = (periodEnd: number) => {
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: member.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: periodEnd - 30 * DAY_SECONDS,
          periodEnd,
        }),
      );
    };

    mockSub(startSec + 30 * DAY_SECONDS);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          id: invoiceId,
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: startSec + 30 * DAY_SECONDS,
        }),
      ),
      [200],
    );
    const afterRedelivery = await billing.readBillingStatus(member);
    expect(afterRedelivery.credits).toBe(20_000);
    expect(afterRedelivery.creditGrants).toHaveLength(1);

    const stalePeriodEnd = startSec - 60 * DAY_SECONDS;
    const staleInvoiceId = stripeId("in_stale");
    mockSub(stalePeriodEnd);
    const staleEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: staleInvoiceId,
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: stalePeriodEnd - 30 * DAY_SECONDS,
        periodEnd: stalePeriodEnd,
      }),
    );
    await webhooks.postStripeEvent(staleEvent, [200]);
    const afterStale = await billing.readBillingStatus(member);
    expect(afterStale.credits).toBe(20_000);
    expect(afterStale.creditGrants).toHaveLength(1);
    expect(afterStale.currentPeriodEnd).toBe(
      new Date(stalePeriodEnd * 1000).toISOString(),
    );

    const renewalPeriodEnd = startSec + 60 * DAY_SECONDS;
    mockSub(renewalPeriodEnd);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec + 30 * DAY_SECONDS,
          periodEnd: renewalPeriodEnd,
        }),
      ),
      [200],
    );
    const afterRenewal = await billing.readBillingStatus(member);
    expect(afterRenewal.credits).toBe(40_000);
    expect(afterRenewal.creditGrants).toHaveLength(2);
  });

  it("webhooks-callbacks.bdd-039 (2/2) deduplicates concurrent renewal invoices and ignores stale redeliveries and plan-less invoices", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    const { customerId, subscriptionId } = await runs.grantProEntitlement(
      member,
      { periodEndUnix: startSec + 30 * DAY_SECONDS },
    );

    const mockSub = (periodEnd: number) => {
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: member.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: periodEnd - 30 * DAY_SECONDS,
          periodEnd,
        }),
      );
    };

    const postFastStripe200 = async (
      event: Readonly<Record<string, unknown>>,
    ) => {
      webhooks.acceptNextStripeWebhookEvent(event);
      await accept(
        webhooksStripeApi.post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
        }),
        [200],
      );
    };
    const readFastBilling = async () => {
      signInWithProfile(member);
      const statusRes = await accept(
        billingStatusApi.get({ headers: SESSION_HEADERS }),
        [200],
      );
      return statusRes.body;
    };

    const stalePeriodEnd = startSec - 60 * DAY_SECONDS;
    const staleEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: stripeId("in_stale"),
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: stalePeriodEnd - 30 * DAY_SECONDS,
        periodEnd: stalePeriodEnd,
      }),
    );
    mockSub(stalePeriodEnd);
    await postFastStripe200(staleEvent);

    const renewalPeriodEnd = startSec + 60 * DAY_SECONDS;
    mockSub(renewalPeriodEnd);
    await postFastStripe200(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec + 30 * DAY_SECONDS,
          periodEnd: renewalPeriodEnd,
        }),
      ),
    );

    const dupEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: stripeId("in_dup"),
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: startSec + 60 * DAY_SECONDS,
        periodEnd: startSec + 90 * DAY_SECONDS,
      }),
    );
    mockSub(startSec + 90 * DAY_SECONDS);
    await Promise.all([
      postFastStripe200(dupEvent),
      postFastStripe200(dupEvent),
    ]);
    const afterConcurrent = await readFastBilling();
    expect(afterConcurrent.credits).toBe(60_000);
    expect(afterConcurrent.creditGrants).toHaveLength(3);

    mockSub(stalePeriodEnd);
    await postFastStripe200(staleEvent);
    mockSub(startSec + 90 * DAY_SECONDS);
    await postFastStripe200(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: null,
          periodStart: startSec + 60 * DAY_SECONDS,
          periodEnd: startSec + 90 * DAY_SECONDS,
        }),
      ),
    );
    const finalStatus = await readFastBilling();
    expect(finalStatus.credits).toBe(60_000);
  });

  it("webhooks-callbacks.bdd-040 atomically accumulates distinct auto-recharge invoices", async () => {
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    webhooks.configureStripeBillingEnv();
    await runs.grantProEntitlement(member);

    const autoEvent = (invoiceId: string) => {
      return stripeEvent("invoice.paid", {
        id: invoiceId,
        customer: null,
        subtotal: 0,
        metadata: {
          type: "auto_recharge",
          orgId,
          creditsAmount: "5000",
        },
        parent: null,
        lines: { has_more: false, data: [] },
      });
    };

    const invoiceA = stripeId("in_auto_a");
    const invoiceB = stripeId("in_auto_b");
    await Promise.all([
      webhooks.postStripeEvent(autoEvent(invoiceA), [200]),
      webhooks.postStripeEvent(autoEvent(invoiceA), [200]),
      webhooks.postStripeEvent(autoEvent(invoiceB), [200]),
    ]);

    const status = await billing.readBillingStatus(member);
    expect(status.credits).toBe(30_000);
    const autoGrants = status.creditGrants.filter((grant) => {
      return grant.source === "auto_recharge";
    });
    expect(autoGrants).toHaveLength(2);
    for (const grant of autoGrants) {
      expect(grant).toMatchObject({ amount: 5000, remaining: 5000 });
      expect(new Date(grant.expiresAt).getUTCFullYear()).toBeGreaterThanOrEqual(
        2999,
      );
    }
  });

  it("webhooks-callbacks.bdd-041 (1/2) grants, refreshes, and clamps trial credits across trial invoices and updates", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();

    const customerId = stripeId("cus");
    const subscriptionId = stripeId("sub");
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });

    const trial1End = startSec + 7 * DAY_SECONDS;
    const period1End = startSec + 30 * DAY_SECONDS;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscriptionObject({
        id: subscriptionId,
        customerId,
        priceId: "price_bdd_pro",
        status: "trialing",
        periodStart: startSec,
        periodEnd: period1End,
        trialEnd: trial1End,
      }),
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: period1End,
        }),
      ),
      [200],
    );
    const afterFirst = await billing.readBillingStatus(member);
    expect(afterFirst).toMatchObject({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "trialing",
      currentPeriodEnd: new Date(period1End * 1000).toISOString(),
    });
    expect(afterFirst.creditExpiry.nextExpiryDate).toBe(
      new Date(trial1End * 1000).toISOString(),
    );

    const trial2End = startSec + 14 * DAY_SECONDS;
    const period2End = startSec + 60 * DAY_SECONDS;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscriptionObject({
        id: subscriptionId,
        customerId,
        priceId: "price_bdd_pro",
        status: "trialing",
        periodStart: startSec,
        periodEnd: period2End,
        trialEnd: trial2End,
      }),
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: period2End,
        }),
      ),
      [200],
    );
    const afterSecond = await billing.readBillingStatus(member);
    expect(afterSecond.credits).toBe(20_000);
    expect(afterSecond.creditGrants).toHaveLength(1);
    expect(afterSecond.currentPeriodEnd).toBe(
      new Date(period2End * 1000).toISOString(),
    );
    expect(afterSecond.creditExpiry.nextExpiryDate).toBe(
      new Date(trial2End * 1000).toISOString(),
    );

    const shortenedTrialEnd = startSec + 10 * DAY_SECONDS;
    const shortenedSub = stripeSubscriptionObject({
      id: subscriptionId,
      customerId,
      priceId: "price_bdd_pro",
      status: "trialing",
      periodStart: startSec,
      periodEnd: shortenedTrialEnd,
      trialEnd: shortenedTrialEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(shortenedSub);
    const shortenEvent = stripeEvent(
      "customer.subscription.updated",
      shortenedSub,
      { trial_end: trial2End },
    );
    await webhooks.postStripeEvent(shortenEvent, [200]);
    const afterShorten = await billing.readBillingStatus(member);
    const shortenedIso = new Date(shortenedTrialEnd * 1000).toISOString();
    expect(afterShorten.currentPeriodEnd).toBe(shortenedIso);
    expect(afterShorten.creditExpiry.nextExpiryDate).toBe(shortenedIso);

    const overlapResults = await Promise.all([
      webhooks.postStripeEvent(shortenEvent, [200, 500]),
      webhooks.postStripeEvent(shortenEvent, [200, 500]),
    ]);
    expect(
      overlapResults.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    if (
      overlapResults.some((result) => {
        return result.status === 500;
      })
    ) {
      await webhooks.postStripeEvent(shortenEvent, [200]);
    }
    const afterOverlap = await billing.readBillingStatus(member);
    expect(afterOverlap).toMatchObject({
      credits: 20_000,
      subscriptionStatus: "trialing",
      currentPeriodEnd: shortenedIso,
    });
    expect(afterOverlap.creditGrants).toHaveLength(1);
    expect(afterOverlap.creditExpiry.nextExpiryDate).toBe(shortenedIso);
  });

  it("webhooks-callbacks.bdd-041 (2/2) preserves trial credits on checkout and drops expired trial-extension invoices", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();

    const customerId = stripeId("cus");
    const subscriptionId = stripeId("sub");
    const trialEnd = startSec + 10 * DAY_SECONDS;
    const trialSub = stripeSubscriptionObject({
      id: subscriptionId,
      customerId,
      priceId: "price_bdd_pro",
      status: "trialing",
      periodStart: startSec,
      periodEnd: trialEnd,
      trialEnd,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(trialSub);

    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: trialEnd,
        }),
      ),
      [200],
    );

    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs"),
        mode: "subscription",
        payment_status: "no_payment_required",
        customer: customerId,
        subscription: subscriptionId,
        metadata: { orgId: member.orgId },
      }),
      [200],
    );
    const afterCheckout = await billing.readBillingStatus(member);
    expect(afterCheckout.credits).toBe(20_000);

    mockNow((trialEnd + 60) * 1000);
    const extensionInvoice = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: stripeId("in_ext"),
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: startSec,
        periodEnd: trialEnd,
      }),
    );
    await webhooks.postStripeEvent(extensionInvoice, [200]);
    const afterExpired1 = await billing.readBillingStatus(member);
    expect(afterExpired1).toMatchObject({
      credits: 0,
      creditGrants: [],
      subscriptionStatus: "trialing",
    });

    await webhooks.postStripeEvent(extensionInvoice, [200]);
    const afterExpired2 = await billing.readBillingStatus(member);
    expect(afterExpired2.credits).toBe(0);
  });

  it("webhooks-callbacks.bdd-045 keeps a newer purchase when the previous invoice is redelivered", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    webhooks.configureStripeBillingEnv();

    const { customerId, subscriptionId: originalSubId } =
      await runs.grantProEntitlement(member, {
        periodEndUnix: startSec + 30 * DAY_SECONDS,
      });

    const teamSubId = stripeId("sub_team");
    const teamInvoiceId = stripeId("in_team");
    const teamSub = stripeSubscriptionObject({
      id: teamSubId,
      customerId,
      priceId: "price_bdd_team",
      status: "active",
      periodStart: startSec,
      periodEnd: startSec + 30 * DAY_SECONDS,
    });
    const teamInvoiceEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: teamInvoiceId,
        customerId,
        subscriptionId: teamSubId,
        priceId: "price_bdd_team",
        periodStart: startSec,
        periodEnd: startSec + 30 * DAY_SECONDS,
      }),
    );
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(teamSub);
    await webhooks.postStripeEvent(teamInvoiceEvent, [200]);
    expect((await billing.readBillingStatus(member)).credits).toBe(140_000);

    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        ...teamSub,
        status: "canceled",
      }),
      [200],
    );

    const newerProSubId = stripeId("sub_pro_new");
    const newerProSub = stripeSubscriptionObject({
      id: newerProSubId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd: startSec + 30 * DAY_SECONDS,
    });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (id: unknown) => {
        if (id === teamSubId) {
          return Promise.resolve({ ...teamSub, status: "canceled" });
        }
        return Promise.resolve(newerProSub);
      },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [newerProSub],
      has_more: false,
    });
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_new_pro"),
        mode: "subscription",
        payment_status: "paid",
        customer: customerId,
        subscription: newerProSubId,
        metadata: { orgId: member.orgId },
      }),
      [200],
    );

    const beforeRedelivery = await billing.readBillingStatus(member);
    const canceledIds: string[] = [];
    context.mocks.stripe.subscriptions.cancel.mockImplementation(
      (id: unknown) => {
        if (typeof id === "string") {
          canceledIds.push(id);
        }
        return Promise.resolve({ id, status: "canceled" });
      },
    );

    await webhooks.postStripeEvent(teamInvoiceEvent, [200]);
    for (const canceledId of canceledIds) {
      if (canceledId === originalSubId || canceledId === teamSubId) {
        await webhooks.postStripeEvent(
          stripeEvent("customer.subscription.deleted", {
            id: canceledId,
            customer: customerId,
            status: "canceled",
            metadata: {},
            items: { data: [{ price: { id: "price_bdd_team" } }] },
          }),
          [200],
        );
      }
    }

    const afterRedelivery = await billing.readBillingStatus(member);
    expect(afterRedelivery).toMatchObject({
      tier: beforeRedelivery.tier,
      credits: beforeRedelivery.credits,
      hasSubscription: true,
      subscriptionStatus: "active",
      creditGrants: beforeRedelivery.creditGrants,
    });
  });

  it("webhooks-callbacks.bdd-047 keeps Stripe quantity across prorations and stale events", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });
    webhooks.configureStripeBillingEnv();

    const { customerId } = await runs.grantProEntitlement(member, {
      periodEndUnix: periodEnd,
    });
    const concSubId = stripeId("sub_conc");

    const concSub = (quantity: number, status = "active") => {
      return stripeSubscriptionObject({
        id: concSubId,
        customerId,
        priceId: "price_bdd_concurrency",
        status,
        periodStart: startSec,
        periodEnd,
        quantity,
        metadata: { purpose: "concurrency_subscription" },
      });
    };

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(concSub(10));
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_conc_10"),
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concSubId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: "price_bdd_concurrency" },
              quantity: 10,
              amount: 1000,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
          ],
        },
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).concurrencySubscriptions,
    ).toMatchObject([{ id: concSubId, quantity: 10 }]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(concSub(2));
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", concSub(2)),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_conc_prorate"),
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concSubId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il_credit"),
              price: { id: "price_bdd_concurrency" },
              quantity: 10,
              amount: -800,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
            {
              id: stripeId("il_charge"),
              price: { id: "price_bdd_concurrency" },
              quantity: 2,
              amount: 200,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
          ],
        },
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).concurrencySubscriptions,
    ).toMatchObject([{ id: concSubId, quantity: 2 }]);

    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", concSub(10)),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", concSub(10)),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).concurrencySubscriptions,
    ).toMatchObject([{ id: concSubId, quantity: 2 }]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concSub(0, "canceled"),
    );
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.deleted", concSub(2, "canceled")),
      [200],
    );
  });

  it("webhooks-callbacks.bdd-049 binds checkout and dashboard subscriptions to orgs without double-binding", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });
    const lateMember = bdd.user({ orgRole: "org:admin" });
    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();

    const customerId = stripeId("cus_primary");
    const subId = stripeId("sub_primary");
    const checkoutSubId = stripeId("sub_checkout");
    const otherSubId = stripeId("sub_other");
    const unknownCustomerId = stripeId("cus_unknown");
    const conflictingCustomerId = stripeId("cus_conflict");
    const lateCustomerId = stripeId("cus_late");
    const lateSubId = stripeId("sub_late");

    context.mocks.stripe.customers.retrieve.mockImplementation(
      (id: unknown) => {
        if (id === customerId || id === conflictingCustomerId) {
          return Promise.resolve({ id, metadata: { orgId: member.orgId } });
        }
        if (id === lateCustomerId) {
          return Promise.resolve({ id, metadata: { orgId: lateMember.orgId } });
        }
        return Promise.resolve({ id, metadata: {} });
      },
    );
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: lateMember.orgId,
      slug: "late-org",
      name: "Late Org",
      createdBy: lateMember.userId,
    });

    const dashSub = stripeSubscriptionObject({
      id: subId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(dashSub);
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.created", dashSub),
      [200],
    );
    const afterDash = await billing.readBillingStatus(member);
    expect(afterDash).toMatchObject({
      hasSubscription: true,
      subscriptionStatus: "active",
      tier: "limited-free-1",
      currentPeriodEnd: null,
    });

    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscriptionObject({
          id: stripeId("sub_incomplete"),
          customerId,
          priceId: "price_bdd_pro",
          status: "incomplete",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      subscriptionStatus: "active",
      tier: "limited-free-1",
    });

    const checkoutSub = stripeSubscriptionObject({
      id: checkoutSubId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(checkoutSub);
    const checkoutEvent = stripeEvent("checkout.session.completed", {
      id: stripeId("cs_sub"),
      mode: "subscription",
      payment_status: "paid",
      customer: customerId,
      subscription: checkoutSubId,
      metadata: { orgId: member.orgId },
    });
    await webhooks.postStripeEvent(checkoutEvent, [200]);
    await webhooks.postStripeEvent(checkoutEvent, [200]);
    expect((await billing.readBillingStatus(member)).subscriptionStatus).toBe(
      "active",
    );

    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId: checkoutSubId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      tier: "pro",
      credits: 20_000,
    });

    const otherSub = stripeSubscriptionObject({
      id: otherSubId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(otherSub);
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_same_tier"),
        mode: "subscription",
        payment_status: "paid",
        customer: customerId,
        subscription: otherSubId,
        metadata: { orgId: member.orgId },
      }),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscriptionObject({
          id: stripeId("sub_unk"),
          customerId: unknownCustomerId,
          priceId: "price_bdd_pro",
          status: "active",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscriptionObject({
          id: stripeId("sub_conf"),
          customerId: conflictingCustomerId,
          priceId: "price_bdd_pro",
          status: "active",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "active",
      credits: 20_000,
    });

    const lateSub = stripeSubscriptionObject({
      id: lateSubId,
      customerId: lateCustomerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(lateSub);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId: lateCustomerId,
          subscriptionId: lateSubId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(lateMember)).resolves.toMatchObject({
      tier: "pro",
      credits: 20_000,
      hasSubscription: true,
    });
  });

  it("webhooks-callbacks.bdd-050 grants purchased custom credit amounts", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    const baseline = (await billing.readBillingStatus(member)).credits;

    const campaignSessionId = stripeId("cs_zero");
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: campaignSessionId,
        mode: "payment",
        payment_status: "unpaid",
        invoice: null,
        subscription: null,
        customer: null,
        amount_subtotal: 0,
        amount_total: 0,
        metadata: {
          purpose: "one_time_purchase",
          orgId,
          campaignKey: "ZERO100",
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(member)).credits).toBe(baseline);

    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.async_payment_succeeded", {
        id: campaignSessionId,
        mode: "payment",
        payment_status: "paid",
        invoice: null,
        subscription: null,
        customer: null,
        amount_subtotal: 0,
        amount_total: 0,
        metadata: {
          purpose: "one_time_purchase",
          orgId,
          campaignKey: "ZERO100",
        },
      }),
      [200],
    );
    const afterAsync = await billing.readBillingStatus(member);
    expect(afterAsync.credits).toBe(baseline + 100_000);
    expect(afterAsync.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "one_time_purchase",
        amount: 100_000,
      }),
    );

    const expiry45Iso = new Date(startMs + 45 * DAY_MS).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_legacy_credit"),
        mode: "payment",
        payment_status: "paid",
        invoice: null,
        subscription: null,
        customer: null,
        amount_total: 10_000,
        metadata: {
          purpose: "credit_purchase",
          orgId,
          creditsAmountMode: "amount_total",
          creditsExpiresAt: expiry45Iso,
        },
      }),
      [200],
    );
    const afterLegacy = await billing.readBillingStatus(member);
    expect(afterLegacy.credits).toBe(baseline + 200_000);
    expect(afterLegacy.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "credit_purchase",
        amount: 100_000,
        expiresAt: expiry45Iso,
      }),
    );

    const creditInvoiceId = stripeId("in_credit_sub");
    const expiry90Iso = new Date(startMs + 90 * DAY_MS).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_inv_credit"),
        mode: "payment",
        payment_status: "paid",
        invoice: creditInvoiceId,
        subscription: null,
        customer: null,
        amount_subtotal: 10_000,
        metadata: {
          purpose: "credit_purchase",
          orgId,
          creditsAmountMode: "amount_subtotal",
          creditsExpiresAt: expiry90Iso,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(member)).credits).toBe(
      baseline + 200_000,
    );

    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: creditInvoiceId,
        customer: null,
        subtotal: 10_000,
        metadata: {
          purpose: "credit_purchase",
          orgId,
          creditsExpiresAt: expiry90Iso,
        },
        parent: null,
        lines: { has_more: false, data: [] },
      }),
      [200],
    );
    const afterInvoice = await billing.readBillingStatus(member);
    expect(afterInvoice.credits).toBe(baseline + 300_000);
    expect(afterInvoice.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "credit_purchase",
        amount: 100_000,
        expiresAt: expiry90Iso,
      }),
    );
  });

  it("webhooks-callbacks.bdd-051 (1/2) handles cancel_at_period_end, ignores mismatched setup checkouts, and applies restore and downgrade checkouts", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    webhooks.configureStripeBillingEnv();
    const { customerId, subscriptionId } = await runs.grantProEntitlement(
      member,
      { periodEndUnix: periodEnd },
    );

    const cancelAtEndSub = stripeSubscriptionObject({
      id: subscriptionId,
      customerId,
      priceId: "price_bdd_pro",
      periodStart: startSec,
      periodEnd,
      cancelAtPeriodEnd: true,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelAtEndSub,
    );
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", cancelAtEndSub),
      [200],
    );
    const afterCancelFlag = await billing.readBillingStatus(member);
    expect(afterCancelFlag.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });

    await Promise.all(
      [
        {
          id: stripeId("cs_pay"),
          mode: "payment",
          customer: customerId,
          metadata: { purpose: "billing_restore", orgId, subscriptionId },
        },
        {
          id: stripeId("cs_nocus"),
          mode: "setup",
          customer: null,
          metadata: { purpose: "billing_restore", orgId, subscriptionId },
        },
        {
          id: stripeId("cs_wrongsub"),
          mode: "setup",
          customer: customerId,
          metadata: {
            purpose: "billing_restore",
            orgId,
            subscriptionId: "sub_other",
          },
        },
        {
          id: stripeId("cs_team"),
          mode: "setup",
          customer: customerId,
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId,
            targetTier: "team",
          },
        },
      ].map((mismatched) => {
        return webhooks.postStripeEvent(
          stripeEvent("checkout.session.completed", mismatched),
          [200],
        );
      }),
    );
    expect(
      (await billing.readBillingStatus(member)).scheduledChange,
    ).toStrictEqual(afterCancelFlag.scheduledChange);

    const customerUpdates: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    context.mocks.stripe.customers.update.mockImplementation(
      (id: unknown, payload: unknown) => {
        customerUpdates.push({ id, payload });
        return Promise.resolve({ id });
      },
    );
    context.mocks.stripe.subscriptions.update.mockImplementation(
      (id: unknown, payload: unknown) => {
        subscriptionUpdates.push({ id, payload });
        return Promise.resolve(
          stripeSubscriptionObject({
            id: subscriptionId,
            customerId,
            priceId: "price_bdd_pro",
            periodStart: startSec,
            periodEnd,
            cancelAtPeriodEnd:
              typeof payload === "object" &&
              payload !== null &&
              "cancel_at_period_end" in payload &&
              Boolean(payload.cancel_at_period_end),
          }),
        );
      },
    );

    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_restore"),
        mode: "setup",
        customer: customerId,
        setup_intent: {
          id: "seti_restore",
          payment_method: "pm_bdd_restore",
        },
        metadata: { purpose: "billing_restore", orgId, subscriptionId },
      }),
      [200],
    );
    expect(customerUpdates.at(-1)).toStrictEqual({
      id: customerId,
      payload: {
        invoice_settings: { default_payment_method: "pm_bdd_restore" },
      },
    });
    expect(subscriptionUpdates.at(-1)).toMatchObject({
      id: subscriptionId,
      payload: expect.objectContaining({ cancel_at_period_end: false }),
    });
    expect(
      (await billing.readBillingStatus(member)).scheduledChange,
    ).toBeNull();

    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_downgrade"),
        mode: "setup",
        customer: customerId,
        setup_intent: {
          id: "seti_downgrade",
          payment_method: "pm_bdd_downgrade",
        },
        metadata: {
          purpose: "billing_downgrade",
          orgId,
          subscriptionId,
          targetTier: "limited-free-1",
        },
      }),
      [200],
    );
    expect(customerUpdates.at(-1)).toStrictEqual({
      id: customerId,
      payload: {
        invoice_settings: { default_payment_method: "pm_bdd_downgrade" },
      },
    });
    expect(subscriptionUpdates.at(-1)).toMatchObject({
      id: subscriptionId,
      payload: expect.objectContaining({ cancel_at_period_end: true }),
    });
    expect(
      (await billing.readBillingStatus(member)).scheduledChange,
    ).toMatchObject({ type: "cancel", targetTier: "limited-free-1" });
  });

  it("webhooks-callbacks.bdd-051 (2/2) tracks cancel-ending subscription schedules across release, cancel, and uncancel updates", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });
    if (!member.orgId) {
      throw new Error("Expected member orgId");
    }

    webhooks.configureStripeBillingEnv();
    const { customerId, subscriptionId } = await runs.grantProEntitlement(
      member,
      { periodEndUnix: periodEnd },
    );

    const sched1End = startSec + 60 * DAY_SECONDS;
    const sched1Id = stripeId("sub_sched_1");
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: sched1Id,
      end_behavior: "cancel",
      current_phase: { start_date: startSec, end_date: periodEnd },
      phases: [
        { start_date: startSec, end_date: periodEnd },
        { start_date: periodEnd, end_date: sched1End },
      ],
    });
    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
          scheduleId: sched1Id,
        }),
      ),
      [200],
    );
    const sched1Iso = new Date(sched1End * 1000).toISOString();
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      currentPeriodEnd: sched1Iso,
      scheduledChange: { type: "cancel", effectiveDate: sched1Iso },
    });

    await webhooks.postStripeEvent(
      stripeEvent("subscription_schedule.released", {
        id: sched1Id,
        subscription: subscriptionId,
        customer: customerId,
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).scheduledChange,
    ).toBeNull();

    const sched2End = startSec + 90 * DAY_SECONDS;
    const sched2Id = stripeId("sub_sched_2");
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: sched2Id,
      end_behavior: "cancel",
      current_phase: { start_date: startSec, end_date: periodEnd },
      phases: [{ start_date: startSec, end_date: sched2End }],
    });
    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
          scheduleId: sched2Id,
        }),
      ),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent("subscription_schedule.canceled", {
        id: sched2Id,
        subscription: subscriptionId,
        customer: customerId,
        current_phase: { start_date: startSec, end_date: sched2End },
        phases: [{ start_date: startSec, end_date: sched2End }],
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).scheduledChange,
    ).toMatchObject({
      type: "cancel",
      effectiveDate: new Date(sched2End * 1000).toISOString(),
    });

    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
          cancelAtPeriodEnd: false,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      cancelAtPeriodEnd: false,
      scheduledChange: null,
    });
  });

  it("webhooks-callbacks.bdd-054 preserves org data when a deleted user leaves an uncached Clerk member", async () => {
    webhooks.configureClerkWebhookSecret();
    webhooks.configureStripeBillingEnv();
    const admin = bdd.user({ orgRole: "org:admin" });
    const peer = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    await runs.grantProEntitlement(admin);
    const clerkDeletes: unknown[] = [];
    const stripeMutations: unknown[] = [];
    context.mocks.clerk.organizations.deleteOrganization.mockImplementation(
      (id: unknown) => {
        clerkDeletes.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.stripe.subscriptions.update.mockImplementation(
      (id: unknown) => {
        stripeMutations.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.stripe.subscriptions.cancel.mockImplementation(
      (id: unknown) => {
        stripeMutations.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:member",
            organization: { id: orgId },
            publicUserData: { userId: peer.userId },
          },
        ],
      },
    );

    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: admin.userId },
    });
    const deleted = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(deleted.body).toBe("OK");
    await flushWaitUntilForTest();

    expect(clerkDeletes).toStrictEqual([]);
    expect(stripeMutations).toStrictEqual([]);
    await expect(billing.readBillingStatus(peer)).resolves.toMatchObject({
      tier: "pro",
      hasSubscription: true,
      subscriptionStatus: "active",
    });
  });

  it("webhooks-callbacks.bdd-056 (1/2) disarms the deleted user's automations while leaving another admin's automations enabled", async () => {
    webhooks.configureClerkWebhookSecret();
    webhooks.configureStripeBillingEnv();
    bdd.acceptStorageWrites();

    const org1Admin = bdd.user({ orgRole: "org:admin" });
    const sharedUserOrg1 = bdd.user({
      orgId: org1Admin.orgId,
      orgRole: "org:admin",
    });
    await runs.grantProEntitlement(org1Admin, { tier: "team" });

    const wfOther = await workflows.createWorkflow(org1Admin, {
      name: `other-${randomUUID().slice(0, 6)}`,
      instruction: "Other user workflow",
    });
    const wfShared1 = await workflows.createWorkflow(sharedUserOrg1, {
      name: `shared1-${randomUUID().slice(0, 6)}`,
      instruction: "Shared org1 workflow",
    });
    const otherAutos = await createLoopAndWebhookAutomations(
      org1Admin,
      wfOther,
    );
    const shared1Autos = await createLoopAndWebhookAutomations(
      sharedUserOrg1,
      wfShared1,
    );

    const [otherLoopBefore, s1LoopBefore] = await Promise.all([
      readAutomationAs(org1Admin, otherAutos.loopId),
      readAutomationAs(org1Admin, shared1Autos.loopId),
    ]);

    const clerkDeletes: unknown[] = [];
    context.mocks.clerk.organizations.deleteOrganization.mockImplementation(
      (id: unknown) => {
        clerkDeletes.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            organization: { id: org1Admin.orgId },
            publicUserData: { userId: org1Admin.userId },
          },
        ],
      },
    );

    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: sharedUserOrg1.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();

    expect(clerkDeletes).toStrictEqual([]);
    const [otherLoopAfter, otherWebhookAfter, s1LoopAfter, s1WebhookAfter] =
      await Promise.all([
        readAutomationAs(org1Admin, otherAutos.loopId),
        readAutomationAs(org1Admin, otherAutos.webhookId),
        readAutomationAs(org1Admin, shared1Autos.loopId),
        readAutomationAs(org1Admin, shared1Autos.webhookId),
      ]);
    expect(otherLoopAfter).toMatchObject({
      id: otherLoopBefore.id,
      enabled: true,
      scheduleSummary: otherLoopBefore.scheduleSummary,
    });
    expect(otherWebhookAfter).toMatchObject({
      id: otherAutos.webhookId,
      enabled: true,
      eventType: "webhook-received",
    });
    expect(s1LoopAfter).toMatchObject({
      id: s1LoopBefore.id,
      enabled: false,
      scheduleSummary: s1LoopBefore.scheduleSummary,
    });
    expect(s1WebhookAfter).toMatchObject({
      id: shared1Autos.webhookId,
      enabled: false,
      eventType: "webhook-received",
    });
  });

  it("webhooks-callbacks.bdd-056 (2/2) disarms the deleted user's automations in a second workspace without deleting organizations", async () => {
    webhooks.configureClerkWebhookSecret();
    webhooks.configureStripeBillingEnv();
    bdd.acceptStorageWrites();

    const sharedUserOrg2 = bdd.user({ orgRole: "org:admin" });
    const peerOrg2 = bdd.user({
      orgId: sharedUserOrg2.orgId,
      orgRole: "org:admin",
    });
    await runs.grantProEntitlement(sharedUserOrg2, { tier: "team" });

    const wfShared2 = await workflows.createWorkflow(sharedUserOrg2, {
      name: `shared2-${randomUUID().slice(0, 6)}`,
      instruction: "Shared org2 workflow",
    });
    const shared2Autos = await createLoopAndWebhookAutomations(
      sharedUserOrg2,
      wfShared2,
    );
    const s2LoopBefore = await readAutomationAs(
      sharedUserOrg2,
      shared2Autos.loopId,
    );

    const clerkDeletes: unknown[] = [];
    context.mocks.clerk.organizations.deleteOrganization.mockImplementation(
      (id: unknown) => {
        clerkDeletes.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            organization: { id: sharedUserOrg2.orgId },
            publicUserData: { userId: peerOrg2.userId },
          },
        ],
      },
    );

    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: sharedUserOrg2.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();

    expect(clerkDeletes).toStrictEqual([]);
    const [s2LoopAfter, s2WebhookAfter] = await Promise.all([
      readAutomationAs(peerOrg2, shared2Autos.loopId),
      readAutomationAs(peerOrg2, shared2Autos.webhookId),
    ]);
    expect(s2LoopAfter).toMatchObject({
      id: s2LoopBefore.id,
      enabled: false,
      scheduleSummary: s2LoopBefore.scheduleSummary,
    });
    expect(s2WebhookAfter).toMatchObject({
      id: shared2Autos.webhookId,
      enabled: false,
      eventType: "webhook-received",
    });
  });

  it("webhooks-callbacks.bdd-062 grants and renews Atom invoice-backed Team entitlements", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const end7Sec = startSec + 7 * DAY_SECONDS;
    const end7Iso = new Date(end7Sec * 1000).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_team_1"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          orgId,
          tier: "team",
          duration: "7d",
          atomGrantExpiresAt: end7Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: ATOM_GRANT_PRICE },
              quantity: 1,
              period: { start: startSec, end: end7Sec },
            },
          ],
        },
      }),
      [200],
    );

    const afterFirst = await billing.readBillingStatus(member);
    expect(afterFirst).toMatchObject({
      tier: "team",
      credits: 120_000,
      hasSubscription: false,
      currentPeriodEnd: end7Iso,
      canBuyConcurrency: true,
      canBuyCredits: true,
      workflowWebhookAutomationAllowed: true,
    });
    expect(afterFirst.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        amount: 120_000,
        expiresAt: end7Iso,
      }),
    ]);
    await expect(readVoiceQuota(member)).resolves.toMatchObject({
      allowed: true,
      limit: null,
    });

    const end14Sec = startSec + 14 * DAY_SECONDS;
    const end14Iso = new Date(end14Sec * 1000).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_team_2"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          orgId,
          tier: "team",
          duration: "14d",
          atomGrantExpiresAt: end14Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: ATOM_GRANT_PRICE },
              quantity: 1,
              period: { start: startSec, end: end14Sec },
            },
          ],
        },
      }),
      [200],
    );

    const afterRenewal = await billing.readBillingStatus(member);
    expect(afterRenewal).toMatchObject({
      tier: "team",
      credits: 240_000,
      hasSubscription: false,
      currentPeriodEnd: end14Iso,
      canBuyConcurrency: true,
    });
    expect(
      afterRenewal.creditGrants.map((grant) => {
        return { amount: grant.amount, expiresAt: grant.expiresAt };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        { amount: 120_000, expiresAt: end7Iso },
        { amount: 120_000, expiresAt: end14Iso },
      ]),
    );
  });

  it("webhooks-callbacks.bdd-063 expires Atom day-grant subscription credits at the Atom grant end", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEndUnix = startSec + 30 * DAY_SECONDS;
    const grantEndUnix = startSec + 7 * DAY_SECONDS;
    const grantEndIso = new Date(grantEndUnix * 1000).toISOString();
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    await runs.grantProEntitlement(member, {
      periodEndUnix,
      cancelAtUnix: grantEndUnix,
      subscriptionMetadata: {
        source: "atom_entitlement",
        duration: "7d",
        atomGrantExpiresAt: grantEndIso,
      },
    });

    const status = await billing.readBillingStatus(member);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(grantEndIso);
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        amount: 20_000,
        expiresAt: grantEndIso,
      }),
    ]);
  });

  it("webhooks-callbacks.bdd-066 grants Atom organization credits once and rejects an untrusted grant price", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    const baseline = (await billing.readBillingStatus(member)).credits;

    const expiry90Iso = new Date(startMs + 90 * DAY_MS).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_credits"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          grantType: "credits",
          orgId,
          creditsAmount: "2500",
          creditsExpiresAt: expiry90Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: ATOM_GRANT_PRICE },
              quantity: 1,
              period: { start: startSec, end: startSec + 90 * DAY_SECONDS },
            },
          ],
        },
      }),
      [200],
    );
    const afterTrusted = await billing.readBillingStatus(member);
    expect(afterTrusted.credits).toBe(baseline + 2500);
    expect(afterTrusted.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "credit_purchase",
        amount: 2500,
        expiresAt: expiry90Iso,
      }),
    );

    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_untrusted"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          grantType: "credits",
          orgId,
          creditsAmount: "9000",
          creditsExpiresAt: expiry90Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: "price_untrusted_other" },
              quantity: 1,
              period: { start: startSec, end: startSec + 90 * DAY_SECONDS },
            },
          ],
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(member)).credits).toBe(
      baseline + 2500,
    );
  });

  it("webhooks-callbacks.bdd-067 delivers member credits once without changing a purchased Pro plan", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    const { customerId } = await runs.grantProEntitlement(member);
    const before = await billing.readBillingStatus(member);

    const end7Sec = startSec + 7 * DAY_SECONDS;
    const end7Iso = new Date(end7Sec * 1000).toISOString();
    const memberGrantEvent = stripeEvent("invoice.paid", {
      id: stripeId("in_atom_member"),
      customer: customerId,
      subtotal: 0,
      metadata: {
        purpose: "atom_grant",
        grantType: "usage_pack_credits",
        source: "atom_usage_pack_credits",
        orgId,
        userId: member.userId,
        creditsAmount: "6000",
        creditsExpiresAt: end7Iso,
      },
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: stripeId("il"),
            price: { id: ATOM_GRANT_PRICE },
            quantity: 1,
            period: { start: startSec, end: end7Sec },
          },
        ],
      },
    });

    await webhooks.postStripeEvent(memberGrantEvent, [200]);
    await webhooks.postStripeEvent(memberGrantEvent, [200]);

    const usagePackCredits = await readUsagePackCredits(member);
    expect(usagePackCredits).toMatchObject({
      bonusCredits: 6000,
      purchasedCredits: 0,
    });
    expect(usagePackCredits.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 6000,
        remaining: 6000,
        expiresAt: end7Iso,
      }),
    ]);
    await expect(billing.readBillingStatus(member)).resolves.toStrictEqual(
      before,
    );
  });

  it("webhooks-callbacks.bdd-068 publishes pro plan and member credits exactly once", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const end7Sec = startSec + 7 * DAY_SECONDS;
    const end7Iso = new Date(end7Sec * 1000).toISOString();
    const redeemEvent = stripeEvent("invoice.paid", {
      id: stripeId("in_atom_redeem"),
      customer: stripeId("cus_atom"),
      subtotal: 0,
      metadata: {
        purpose: "atom_grant",
        source: "atom_redeem_code",
        planVersion: "usagePack",
        orgId,
        userId: member.userId,
        tier: "pro",
        duration: "7d",
        atomGrantExpiresAt: end7Iso,
        creditsAmount: "20000",
        creditsExpiresAt: end7Iso,
      },
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: stripeId("il"),
            price: { id: ATOM_GRANT_PRICE },
            quantity: 1,
            period: { start: startSec, end: end7Sec },
          },
        ],
      },
    });

    await webhooks.postStripeEvent(redeemEvent, [200]);
    await webhooks.postStripeEvent(redeemEvent, [200]);

    const status = await billing.readBillingStatus(member);
    expect(status).toMatchObject({
      tier: "pro",
      credits: 0,
      hasSubscription: false,
      subscriptionStatus: "atom_grant",
      currentPeriodEnd: end7Iso,
      showUsagePack: true,
    });

    const usagePackCredits = await readUsagePackCredits(member);
    expect(usagePackCredits.bonusCredits).toBe(20_000);
    expect(usagePackCredits.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 20_000,
        remaining: 20_000,
        expiresAt: end7Iso,
      }),
    ]);
  });

  it("webhooks-callbacks.bdd-006 bootstraps limited-free billing and model providers after Clerk org creation", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const admin = bdd.user({ orgRole: "org:admin" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organization.created",
      data: { id: orgId, created_by: admin.userId, created_at: now() },
    });
    const delivered = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(delivered.body).toBe("OK");
    await flushWaitUntilForTest();

    const [billingStatus, voiceQuota, usagePackCredits, runModels] =
      await Promise.all([
        billing.readBillingStatus(admin),
        readVoiceQuota(admin),
        readUsagePackCredits(admin),
        readRunModels(admin),
      ]);

    expect(billingStatus).toMatchObject({
      tier: "limited-free-1",
      status: "active",
      credits: 0,
      creditGrants: [],
      onboardingPaymentPending: false,
      hasSubscription: false,
      canBuyConcurrency: false,
      autoRechargeAllowed: false,
      restrictedBuiltInModels: true,
      workflowWebhookAutomationAllowed: false,
      concurrencyLimit: 2,
    });
    expect(voiceQuota).toMatchObject({
      allowed: true,
      count: 0,
      limit: 10,
    });
    expect(usagePackCredits).toMatchObject({
      bonusCredits: 1000,
      purchasedCredits: 0,
    });
    expect(usagePackCredits.creditGrants).toHaveLength(1);
    const bonusGrant = usagePackCredits.creditGrants[0];
    expect(bonusGrant).toMatchObject({
      grantType: "bonus",
      amount: 1000,
      remaining: 1000,
    });
    const expiresMs = Date.parse(bonusGrant?.expiresAt ?? "");
    expect(Math.abs(expiresMs - (startMs + 30 * DAY_MS))).toBeLessThan(60_000);
    expect(
      runModels.models.map((entry) => {
        return entry.model;
      }),
    ).toStrictEqual(["auto"]);
  });

  it(
    "webhooks-callbacks.bdd-026 rejects unauthenticated and mismatched sandbox reports",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runner = createDirectRunnerForRunTests();
      const firstMember = bdd.user({ orgRole: "org:admin" });
      const secondMember = bdd.user({ orgRole: "org:admin" });

      await Promise.all([
        runner.registerRunner(),
        deliverOrganizationCreated(context, firstMember),
        deliverOrganizationCreated(context, secondMember),
      ]);
      await runner.addClaudeProvider(firstMember);
      const firstRun = await runner.launchRun(firstMember, {
        prompt: "First member sandbox run for auth boundary",
        model: CLAUDE_MODEL,
      });
      await runner.addClaudeProvider(secondMember);
      const secondRun = await runner.launchRun(secondMember, {
        prompt: "Second member sandbox run for cross-run rejection",
        model: CLAUDE_MODEL,
      });

      const [noAuth, nonSandbox, mismatchedTelemetry, mismatchedUsage] =
        await Promise.all([
          accept(
            webhooksAgentHeartbeatApi.send({
              headers: {},
              body: { runId: firstRun.runId },
            }),
            [401],
          ),
          accept(
            webhooksAgentHeartbeatApi.send({
              headers: { authorization: "Bearer not-a-sandbox-token" },
              body: { runId: firstRun.runId },
            }),
            [401],
          ),
          accept(
            webhooksAgentTelemetryApi.send({
              headers: sandboxHeaders(secondRun.execution.sandboxToken),
              body: { runId: firstRun.runId },
            }),
            [401],
          ),
          accept(
            webhooksAgentUsageEventApi.send({
              headers: sandboxHeaders(secondRun.execution.sandboxToken),
              body: {
                runId: firstRun.runId,
                events: [
                  {
                    idempotencyKey: randomUUID(),
                    kind: "model",
                    provider: "anthropic",
                    category: "input_tokens",
                    quantity: 25,
                  },
                ],
              },
            }),
            [401],
          ),
        ]);

      expect(noAuth.body.error.code).toBe("UNAUTHORIZED");
      expect(nonSandbox.body.error.code).toBe("UNAUTHORIZED");
      expect(mismatchedTelemetry.body.error.code).toBe("UNAUTHORIZED");
      expect(mismatchedUsage.body.error.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "webhooks-callbacks.bdd-027 accepts a sandbox callback lifecycle through the run webhooks",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runner = createDirectRunnerForRunTests();
      const member = bdd.user({ orgRole: "org:admin" });

      await Promise.all([
        runner.registerRunner(),
        deliverOrganizationCreated(context, member),
      ]);
      await runner.addClaudeProvider(member);
      const launched = await runner.launchRun(member, {
        prompt: "Lifecycle check across heartbeat, events, and complete",
        model: CLAUDE_MODEL,
      });
      const headers = sandboxHeaders(launched.execution.sandboxToken);

      const heartbeat = await accept(
        webhooksAgentHeartbeatApi.send({
          headers,
          body: { runId: launched.runId },
        }),
        [200],
      );
      expect(heartbeat.body).toMatchObject({ ok: true });

      const events = await accept(
        webhooksAgentEventsApi.send({
          headers,
          body: {
            runId: launched.runId,
            events: [
              {
                type: "system",
                sequenceNumber: 1,
                rawData: { message: "sandbox started" },
              },
            ],
          },
        }),
        [200],
      );
      expect(events.body).toStrictEqual({
        received: 1,
        firstSequence: 1,
        lastSequence: 1,
      });

      const completed = await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: {
            runId: launched.runId,
            exitCode: 1,
            error: "Sandbox exited",
            lastEventSequence: 1,
          },
        }),
        [200],
      );
      launched.trackedEntry.done = true;
      expect(completed.body).toStrictEqual({
        success: true,
        status: "failed",
      });
    },
  );

  it(
    "webhooks-callbacks.bdd-028 rejects mismatched sandbox artifact reports",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runner = createDirectRunnerForRunTests();
      const firstMember = bdd.user({ orgRole: "org:admin" });
      const secondMember = bdd.user({ orgRole: "org:admin" });

      await Promise.all([
        runner.registerRunner(),
        deliverOrganizationCreated(context, firstMember),
        deliverOrganizationCreated(context, secondMember),
      ]);
      await runner.addClaudeProvider(firstMember);
      const firstRun = await runner.launchRun(firstMember, {
        prompt: "First run owning memory mount for artifact auth test",
        model: CLAUDE_MODEL,
      });
      await runner.addClaudeProvider(secondMember);
      const secondRun = await runner.launchRun(secondMember, {
        prompt: "Second run attempting cross-run artifact reports",
        model: CLAUDE_MODEL,
      });

      const firstMemory = firstRun.execution.startupInputs.memory;
      if (!firstMemory) {
        throw new Error(
          "Expected canonical Memory writeback mount on first run",
        );
      }
      const secondHeaders = sandboxHeaders(secondRun.execution.sandboxToken);
      const sampleFile = storageTextFile("notes.md", "foreign write attempt");

      const [
        eventsRes,
        completeRes,
        completeOutputsRes,
        prepareRes,
        commitRes,
      ] = await Promise.all([
        accept(
          webhooksAgentEventsApi.send({
            headers: secondHeaders,
            body: {
              runId: firstRun.runId,
              events: [{ type: "system", sequenceNumber: 1, rawData: {} }],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: secondHeaders,
            body: { runId: firstRun.runId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: secondHeaders,
            body: {
              runId: firstRun.runId,
              exitCode: 0,
              completion: {
                cliAgentType: "claude-code",
                cliAgentSessionId: `cross-session-${firstRun.runId}`,
                cliAgentSessionHistoryDisposition: "native_only",
                storageOutputs: [],
              },
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentStoragePrepareApi.prepare({
            headers: secondHeaders,
            body: {
              runId: firstRun.runId,
              storageId: firstMemory.storageId,
              parentVersionId: firstMemory.versionId,
              files: [sampleFile],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentStorageCommitApi.commit({
            headers: secondHeaders,
            body: {
              runId: firstRun.runId,
              storageId: firstMemory.storageId,
              parentVersionId: firstMemory.versionId,
              versionId: "b".repeat(64),
              files: [sampleFile],
            },
          }),
          [401],
        ),
      ]);

      expect(eventsRes.body.error.code).toBe("UNAUTHORIZED");
      expect(completeRes.body.error.code).toBe("UNAUTHORIZED");
      expect(completeOutputsRes.body.error.code).toBe("UNAUTHORIZED");
      expect(prepareRes.body.error.code).toBe("UNAUTHORIZED");
      expect(commitRes.body.error.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "webhooks-callbacks.bdd-029 prepares, commits, dedups, and bounds sandbox storage writes for the run org",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runner = createDirectRunnerForRunTests();
      const s3 = installWorkflowVolumeS3Fixture(context);
      const member = bdd.user({ orgRole: "org:admin" });
      const orgId = member.orgId;
      if (!orgId) {
        throw new Error("Expected member orgId");
      }

      await Promise.all([
        runner.registerRunner(),
        deliverOrganizationCreated(context, member),
      ]);
      await runner.addClaudeProvider(member);
      const firstRun = await runner.launchRun(member, {
        prompt: "Writeback storage prepare, commit, dedup, and bounds check",
        model: CLAUDE_MODEL,
      });
      const memory = firstRun.execution.startupInputs.memory;
      if (!memory) {
        throw new Error("Expected canonical Memory writeback mount");
      }
      const headers = sandboxHeaders(firstRun.execution.sandboxToken);

      const unmounted = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers,
          body: {
            runId: firstRun.runId,
            storageId: randomUUID(),
            files: [],
          },
        }),
        [404],
      );
      expect(unmounted.body.error.message).toBe("Writeback storage not found");

      const htmlContent = "h".repeat(2048);
      const htmlFile = storageTextFile("index.html", htmlContent);
      const prepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers,
          body: {
            runId: firstRun.runId,
            storageId: memory.storageId,
            parentVersionId: memory.versionId,
            files: [htmlFile],
          },
        }),
        [200],
      );
      expect(prepared.body.existing).toBeFalsy();
      const uploads = prepared.body.uploads;
      if (!uploads) {
        throw new Error("Expected archive and manifest presigned uploads");
      }
      expect(uploads.archive.key).toContain(orgId);
      expect(uploads.manifest.key).toContain(orgId);
      expect(uploads.archive.presignedUrl).toMatch(/^https:\/\//u);
      expect(uploads.manifest.presignedUrl).toMatch(/^https:\/\//u);

      s3.objects.set(
        uploads.archive.key,
        memoryArchive("index.html", htmlContent),
      );
      s3.objects.set(
        uploads.manifest.key,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files: [htmlFile],
            createdAt: nowDate().toISOString(),
          }),
        ),
      );

      const committed = await accept(
        webhooksAgentStorageCommitApi.commit({
          headers,
          body: {
            runId: firstRun.runId,
            storageId: memory.storageId,
            parentVersionId: memory.versionId,
            versionId: prepared.body.versionId,
            files: [htmlFile],
          },
        }),
        [200],
      );
      expect(committed.body).toMatchObject({
        success: true,
        versionId: prepared.body.versionId,
        storageName: "memory",
        size: 2048,
        fileCount: 1,
      });

      const [duplicatePrepare, mismatchedCommit, oversizedPrepare] =
        await Promise.all([
          accept(
            webhooksAgentStoragePrepareApi.prepare({
              headers,
              body: {
                runId: firstRun.runId,
                storageId: memory.storageId,
                parentVersionId: prepared.body.versionId,
                files: [htmlFile],
              },
            }),
            [200],
          ),
          accept(
            webhooksAgentStorageCommitApi.commit({
              headers,
              body: {
                runId: firstRun.runId,
                storageId: memory.storageId,
                parentVersionId: prepared.body.versionId,
                versionId: "0".repeat(64),
                files: [htmlFile],
              },
            }),
            [400],
          ),
          accept(
            webhooksAgentStoragePrepareApi.prepare({
              headers,
              body: {
                runId: firstRun.runId,
                storageId: memory.storageId,
                parentVersionId: prepared.body.versionId,
                files: [
                  {
                    path: "oversized-part-1.bin",
                    hash: "a".repeat(64),
                    size: 60 * 1024 * 1024,
                  },
                  {
                    path: "oversized-part-2.bin",
                    hash: "b".repeat(64),
                    size: 60 * 1024 * 1024,
                  },
                ],
              },
            }),
            [413],
          ),
        ]);

      expect(duplicatePrepare.body).toStrictEqual({
        versionId: prepared.body.versionId,
        existing: true,
      });
      expect(mismatchedCommit.body.error.message).toBe(
        "Version ID mismatch - files may have changed",
      );
      expect(oversizedPrepare.body.error.code).toBe("PAYLOAD_TOO_LARGE");

      signInWithProfile(member);
      await accept(
        runsCancelApi.cancel({
          headers: SESSION_HEADERS,
          params: { id: firstRun.runId },
        }),
        [200],
      );
      await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: {
            runId: firstRun.runId,
            exitCode: 137,
            error: "Cancelled after storage commit",
          },
        }),
        [200],
      );
      firstRun.trackedEntry.done = true;
      await flushWaitUntilForTest();

      signInWithProfile(member);
      const cancelledRun = await accept(
        runsByIdApi.getById({
          headers: SESSION_HEADERS,
          params: { id: firstRun.runId },
        }),
        [200],
      );
      expect(cancelledRun.body.status).toBe("cancelled");

      const nextRun = await runner.launchRun(member, {
        prompt: "Follow-up run verifying committed Memory archive",
        threadId: firstRun.threadId,
        model: CLAUDE_MODEL,
      });
      expect(nextRun.execution.startupInputs.memory).toMatchObject({
        storageId: memory.storageId,
        versionId: prepared.body.versionId,
      });
      expect(nextRun.execution.startupInputs.memory?.archiveUrl).toMatch(
        /^https:\/\//u,
      );
    },
  );

  it(
    "webhooks-callbacks.bdd-033 rejects prepare before issuing upload URLs after cancelled",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runner = createDirectRunnerForRunTests();
      const member = bdd.user({ orgRole: "org:admin" });

      await Promise.all([
        runner.registerRunner(),
        deliverOrganizationCreated(context, member),
      ]);
      await runner.addClaudeProvider(member);
      const launched = await runner.launchRun(member, {
        prompt: "Cancel run before storage prepare",
        model: CLAUDE_MODEL,
      });
      const memory = launched.execution.startupInputs.memory;
      if (!memory) {
        throw new Error("Expected canonical Memory writeback mount");
      }

      signInWithProfile(member);
      await accept(
        runsCancelApi.cancel({
          headers: SESSION_HEADERS,
          params: { id: launched.runId },
        }),
        [200],
      );
      const afterCancel = await accept(
        runsByIdApi.getById({
          headers: SESSION_HEADERS,
          params: { id: launched.runId },
        }),
        [200],
      );
      expect(afterCancel.body.status).toBe("cancelled");

      const signedUrlsBefore = context.mocks.s3.getSignedUrl.mock.calls.length;
      const rejected = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers: sandboxHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            storageId: memory.storageId,
            parentVersionId: memory.versionId,
            files: [storageTextFile("tiny.txt", "a")],
          },
        }),
        [404],
      );
      expect(rejected.body.error.code).toBe("NOT_FOUND");
      expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
        signedUrlsBefore,
      );
    },
  );

  it(
    "webhooks-callbacks.bdd-034 rejects prepare-then-cancel commit without object writes or moving the current mount",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runner = createDirectRunnerForRunTests();
      const member = bdd.user({ orgRole: "org:admin" });

      await Promise.all([
        runner.registerRunner(),
        deliverOrganizationCreated(context, member),
      ]);
      await runner.addClaudeProvider(member);
      const firstRun = await runner.launchRun(member, {
        prompt: "Prepare storage version then cancel before commit",
        model: CLAUDE_MODEL,
      });
      const initialMemory = firstRun.execution.startupInputs.memory;
      if (!initialMemory) {
        throw new Error("Expected canonical Memory writeback mount");
      }
      const headers = sandboxHeaders(firstRun.execution.sandboxToken);
      const stagedFile = storageTextFile("draft.bin", "d".repeat(2048));
      const prepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers,
          body: {
            runId: firstRun.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            files: [stagedFile],
          },
        }),
        [200],
      );

      signInWithProfile(member);
      await accept(
        runsCancelApi.cancel({
          headers: SESSION_HEADERS,
          params: { id: firstRun.runId },
        }),
        [200],
      );

      const s3SendBefore = context.mocks.s3.send.mock.calls.length;
      const s3SignBefore = context.mocks.s3.getSignedUrl.mock.calls.length;
      const rejectedCommit = await accept(
        webhooksAgentStorageCommitApi.commit({
          headers,
          body: {
            runId: firstRun.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            versionId: prepared.body.versionId,
            files: [stagedFile],
          },
        }),
        [404],
      );
      expect(rejectedCommit.body.error.code).toBe("NOT_FOUND");
      expect(context.mocks.s3.send.mock.calls).toHaveLength(s3SendBefore);
      expect(context.mocks.s3.getSignedUrl.mock.calls).toHaveLength(
        s3SignBefore,
      );

      await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: {
            runId: firstRun.runId,
            exitCode: 137,
            error: "Cancelled before commit",
          },
        }),
        [200],
      );
      firstRun.trackedEntry.done = true;
      await flushWaitUntilForTest();

      const followUp = await runner.launchRun(member, {
        prompt: "Follow-up run keeping original parent Memory version",
        threadId: firstRun.threadId,
        model: CLAUDE_MODEL,
      });
      expect(followUp.execution.startupInputs.memory?.versionId).toBe(
        initialMemory.versionId,
      );
    },
  );

  it(
    "webhooks-callbacks.bdd-042 upgrades to team, picks queued chat threads, and cancels the replaced pro subscription",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const startSec = Math.floor(startMs / 1000);
      const proEnd = startSec + 30 * DAY_SECONDS;
      const teamEnd = startSec + 31 * DAY_SECONDS;
      const teamEndIso = new Date(teamEnd * 1000).toISOString();

      const runner = createDirectRunnerForRunTests();
      const member = bdd.user({ orgRole: "org:admin" });
      const orgId = member.orgId;
      if (!orgId) {
        throw new Error("Expected member orgId");
      }
      webhooks.configureStripeBillingEnv();

      const [{ customerId, subscriptionId: proSubId }] = await Promise.all([
        runs.grantProEntitlement(member, { periodEndUnix: proEnd }),
        runner.registerRunner(),
      ]);
      await runner.addClaudeProvider(member);

      const initialRuns = await runner.launchRunsParallel(member, [
        "Pro slot 1",
        "Pro slot 2",
        "Pro slot 3",
      ]);
      await runner.sendChatInput(member, {
        prompt: "Queued thread waiting for Team capacity",
        model: CLAUDE_MODEL,
      });
      await flushWaitUntilForTest();
      expect(runner.acceptedOrder).toHaveLength(3);

      const teamSubId = stripeId("sub_team_up");
      const teamDiscountId = "di_bdd_team_discount";
      const proSub = stripeSubscriptionObject({
        id: proSubId,
        customerId,
        priceId: "price_bdd_pro",
        status: "active",
        periodStart: startSec,
        periodEnd: proEnd,
        recurring: { interval: "month", interval_count: 1 },
      });
      const teamSub = stripeSubscriptionObject({
        id: teamSubId,
        customerId,
        priceId: "price_bdd_team",
        status: "active",
        periodStart: startSec,
        periodEnd: teamEnd,
        discounts: [{ id: teamDiscountId }],
        recurring: { interval: "month", interval_count: 1 },
      });

      const canceledSubs: { readonly id: unknown; readonly params: unknown }[] =
        [];
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockImplementation(
        (id: unknown) => {
          return Promise.resolve(id === proSubId ? proSub : teamSub);
        },
      );
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [proSub, teamSub],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.cancel.mockImplementation(
        (id: unknown, params: unknown) => {
          canceledSubs.push({ id, params });
          return Promise.resolve({ id, status: "canceled" });
        },
      );

      const postFastStripe200 = async (
        event: Readonly<Record<string, unknown>>,
      ) => {
        webhooks.acceptNextStripeWebhookEvent(event);
        await accept(
          webhooksStripeApi.post({
            body: JSON.stringify(event),
            extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
          }),
          [200],
        );
      };
      const readFastBilling = async () => {
        signInWithProfile(member);
        return (
          await accept(
            billingStatusApi.get({ headers: SESSION_HEADERS }),
            [200],
          )
        ).body;
      };

      const teamInvoiceEvent = stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          id: stripeId("in_team_up"),
          customerId,
          subscriptionId: teamSubId,
          priceId: "price_bdd_team",
          periodStart: startSec,
          periodEnd: teamEnd,
        }),
      );
      await Promise.all([
        postFastStripe200(teamInvoiceEvent),
        postFastStripe200(teamInvoiceEvent),
      ]);
      await flushWaitUntilForTest();

      expect(canceledSubs.length).toBeGreaterThanOrEqual(1);
      expect(canceledSubs[0]).toMatchObject({
        id: proSubId,
        params: { invoice_now: false, prorate: false },
      });

      signInWithProfile(member);
      const [billingAfterTeamRes, voiceAfterTeam, queueAfterTeam] =
        await Promise.all([
          accept(billingStatusApi.get({ headers: SESSION_HEADERS }), [200]),
          readVoiceQuota(member),
          readRunQueue(member),
        ]);
      const billingAfterTeam = billingAfterTeamRes.body;
      expect(billingAfterTeam).toMatchObject({
        tier: "team",
        credits: 140_000,
        concurrencyLimit: 10,
        hasSubscription: true,
        subscriptionStatus: "active",
        currentPeriodEnd: teamEndIso,
      });
      expect(billingAfterTeam.creditGrants).toContainEqual(
        expect.objectContaining({ amount: 120_000 }),
      );
      expect(voiceAfterTeam).toMatchObject({ allowed: true, limit: null });
      expect(runner.acceptedOrder).toHaveLength(4);
      const pickedRunId = runner.acceptedOrder[3];
      if (!pickedRunId) {
        throw new Error("Expected queued thread to start after Team upgrade");
      }
      const pickedExec = runner.acceptedByRunId.get(pickedRunId);
      if (!pickedExec) {
        throw new Error("Missing execution context for picked run");
      }
      const pickedTracked = runner.trackExecution(member, pickedExec);
      expect(queueAfterTeam.concurrency).toMatchObject({
        tier: "team",
        active: 4,
        limit: 10,
      });

      const cancelsBeforeRedelivery = canceledSubs.length;
      await postFastStripe200(teamInvoiceEvent);
      expect(canceledSubs.length).toBeGreaterThan(cancelsBeforeRedelivery);
      expect((await readFastBilling()).credits).toBe(140_000);

      await postFastStripe200(
        stripeEvent(
          "invoice.paid",
          subscriptionInvoiceObject({
            id: stripeId("in_lower_pro"),
            customerId,
            subscriptionId: proSubId,
            priceId: "price_bdd_pro",
            periodStart: startSec,
            periodEnd: proEnd,
          }),
        ),
      );
      await expect(readFastBilling()).resolves.toMatchObject({
        tier: "team",
        credits: 140_000,
      });

      const scheduleId = stripeId("sub_sched_down");
      const scheduleCreates: unknown[] = [];
      const scheduleUpdates: {
        readonly id: unknown;
        readonly payload: unknown;
      }[] = [];
      context.mocks.stripe.customers.update.mockResolvedValue({
        id: customerId,
      });
      context.mocks.stripe.subscriptionSchedules.create.mockImplementation(
        (params: unknown) => {
          scheduleCreates.push(params);
          return Promise.resolve({
            id: scheduleId,
            phases: [{ start_date: startSec, end_date: teamEnd }],
          });
        },
      );
      context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
        (id: unknown, payload: unknown) => {
          scheduleUpdates.push({ id, payload });
          return Promise.resolve({
            id: scheduleId,
            phases: [{ start_date: startSec, end_date: teamEnd }],
          });
        },
      );

      await postFastStripe200(
        stripeEvent("checkout.session.completed", {
          id: stripeId("cs_down_pro"),
          mode: "setup",
          customer: customerId,
          setup_intent: {
            id: "seti_down_pro",
            payment_method: "pm_bdd_team_down",
          },
          metadata: {
            purpose: "billing_downgrade",
            orgId,
            subscriptionId: teamSubId,
            targetTier: "pro",
          },
        }),
      );

      expect(scheduleCreates).toStrictEqual([{ from_subscription: teamSubId }]);
      expect(scheduleUpdates).toHaveLength(1);
      expect(scheduleUpdates[0]).toMatchObject({
        id: scheduleId,
        payload: {
          phases: [
            expect.objectContaining({
              items: [expect.objectContaining({ price: "price_bdd_team" })],
              discounts: [{ discount: teamDiscountId }],
            }),
            expect.objectContaining({
              items: [expect.objectContaining({ price: "price_bdd_pro" })],
              duration: { interval: "month", interval_count: 1 },
              discounts: [{ discount: teamDiscountId }],
            }),
          ],
        },
      });
      expect((await readFastBilling()).scheduledChange).toMatchObject({
        type: "downgrade",
        targetTier: "pro",
        effectiveDate: teamEndIso,
      });

      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      await postFastStripe200(
        stripeEvent("customer.subscription.deleted", {
          ...teamSub,
          status: "canceled",
        }),
      );
      const [billingAfterDelete, voiceAfterDelete] = await Promise.all([
        readFastBilling(),
        readVoiceQuota(member),
      ]);
      expect(billingAfterDelete).toMatchObject({
        tier: "limited-free-1",
        subscriptionStatus: "canceled",
        hasSubscription: false,
        scheduledChange: null,
        canBuyConcurrency: false,
        concurrencyLimit: 2,
      });
      expect(voiceAfterDelete).toMatchObject({ limit: 10 });

      const allRuns = [
        ...initialRuns.map((entry) => {
          return {
            runId: entry.runId,
            sandboxToken: entry.execution.sandboxToken,
            tracked: entry.trackedEntry,
          };
        }),
        {
          runId: pickedRunId,
          sandboxToken: pickedExec.sandboxToken,
          tracked: pickedTracked,
        },
      ];
      signInWithProfile(member);
      await Promise.all(
        allRuns.map(async (entry) => {
          await accept(
            runsCancelApi.cancel({
              headers: SESSION_HEADERS,
              params: { id: entry.runId },
            }),
            [200],
          );
          await accept(
            webhooksAgentCompleteApi.complete({
              headers: sandboxHeaders(entry.sandboxToken),
              body: {
                runId: entry.runId,
                exitCode: 137,
                error: "Cancelled by user",
              },
            }),
            [200],
          );
          entry.tracked.done = true;
        }),
      );
      await flushWaitUntilForTest();
      expect((await readRunQueue(member)).concurrency.active).toBe(0);
    },
  );

  it(
    "webhooks-callbacks.bdd-046 (1/2) grants concurrency slots from Stripe subscription and picks queued chat threads until full",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const startSec = Math.floor(startMs / 1000);
      const periodEnd = startSec + 30 * DAY_SECONDS;
      const periodEndIso = new Date(periodEnd * 1000).toISOString();

      const runner = createDirectRunnerForRunTests();
      const member = bdd.user({ orgRole: "org:admin" });
      const orgId = member.orgId;
      if (!orgId) {
        throw new Error("Expected member orgId");
      }
      webhooks.configureStripeBillingEnv();

      const [{ customerId }] = await Promise.all([
        runs.grantProEntitlement(member, { periodEndUnix: periodEnd }),
        runner.registerRunner(),
        runner.addClaudeProvider(member),
      ]);

      await runner.launchRunsParallel(member, [
        "Base slot 1",
        "Base slot 2",
        "Base slot 3",
      ]);
      await Promise.all([
        runner.sendChatInput(member, {
          prompt: "Queued thread A",
          model: CLAUDE_MODEL,
        }),
        runner.sendChatInput(member, {
          prompt: "Queued thread B",
          model: CLAUDE_MODEL,
        }),
      ]);
      await flushWaitUntilForTest();
      expect(runner.acceptedOrder).toHaveLength(3);

      const concSubId = stripeId("sub_conc_slots");
      const concSub = stripeSubscriptionObject({
        id: concSubId,
        customerId,
        priceId: "price_bdd_concurrency",
        status: "active",
        periodStart: startSec,
        periodEnd,
        quantity: 2,
        cancelAtPeriodEnd: false,
        metadata: { purpose: "concurrency_subscription" },
      });

      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(concSub);

      const postFastStripe200 = async (
        event: Readonly<Record<string, unknown>>,
      ) => {
        webhooks.acceptNextStripeWebhookEvent(event);
        await accept(
          webhooksStripeApi.post({
            body: JSON.stringify(event),
            extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
          }),
          [200],
        );
      };
      const readFastBillingAndQueue = async () => {
        signInWithProfile(member);
        const [statusRes, queueRes] = await Promise.all([
          accept(billingStatusApi.get({ headers: SESSION_HEADERS }), [200]),
          accept(runsQueueApi.getQueue({ headers: SESSION_HEADERS }), [200]),
        ]);
        return { billing: statusRes.body, queue: queueRes.body };
      };

      await postFastStripe200(
        stripeEvent("customer.subscription.created", concSub),
      );
      const concInvoiceEvent = stripeEvent("invoice.paid", {
        id: stripeId("in_conc_slots"),
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concSubId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: "price_bdd_concurrency" },
              quantity: 2,
              amount: 200,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
          ],
        },
      });
      await postFastStripe200(concInvoiceEvent);
      await flushWaitUntilForTest();

      expect(runner.acceptedOrder).toHaveLength(5);
      for (const runId of runner.acceptedOrder.slice(3)) {
        const exec = runner.acceptedByRunId.get(runId);
        if (exec) {
          runner.trackExecution(member, exec);
        }
      }

      const afterGrant = await readFastBillingAndQueue();
      expect(afterGrant.billing.concurrencySubscriptions).toMatchObject([
        {
          id: concSubId,
          quantity: 2,
          currentPeriodEnd: periodEndIso,
          cancelAtPeriodEnd: false,
        },
      ]);
      expect(afterGrant.queue.concurrency).toMatchObject({
        limit: 5,
        active: 5,
      });

      await runner.sendChatInput(member, {
        prompt: "Sixth thread should stay queued at limit 5",
        model: CLAUDE_MODEL,
      });
      await flushWaitUntilForTest();
      expect(runner.acceptedOrder).toHaveLength(5);

      await postFastStripe200(concInvoiceEvent);
      const afterReplay = await readFastBillingAndQueue();
      expect(afterReplay.billing.concurrencySubscriptions).toMatchObject([
        { id: concSubId, quantity: 2 },
      ]);
      expect(afterReplay.queue.concurrency.limit).toBe(5);

      // Drain the five active runs and any queued sixth run while the runner
      // mock is active so background queue pickup never races teardown.
      const stopIds = [...runner.acceptedOrder];
      await Promise.all(
        stopIds.map(async (runId) => {
          const exec = runner.acceptedByRunId.get(runId);
          if (!exec) {
            return;
          }
          await accept(
            webhooksAgentCompleteApi.complete({
              headers: sandboxHeaders(exec.sandboxToken),
              body: {
                runId,
                exitCode: 0,
                completion: {
                  cliAgentType: "claude-code",
                  cliAgentSessionId: `drain-${runId}`,
                  cliAgentSessionHistoryDisposition: "native_only",
                  storageOutputs: [],
                },
              },
            }),
            [200],
          );
          runner.trackExecution(member, exec).done = true;
        }),
      );
      await flushWaitUntilForTest();
      const latePickedIds = runner.acceptedOrder.slice(stopIds.length);
      if (latePickedIds.length > 0) {
        await Promise.all(
          latePickedIds.map(async (runId) => {
            const exec = runner.acceptedByRunId.get(runId);
            if (!exec) {
              return;
            }
            await accept(
              webhooksAgentCompleteApi.complete({
                headers: sandboxHeaders(exec.sandboxToken),
                body: {
                  runId,
                  exitCode: 0,
                  completion: {
                    cliAgentType: "claude-code",
                    cliAgentSessionId: `drain-${runId}`,
                    cliAgentSessionHistoryDisposition: "native_only",
                    storageOutputs: [],
                  },
                },
              }),
              [200],
            );
            runner.trackExecution(member, exec).done = true;
          }),
        );
        await flushWaitUntilForTest();
      }
    },
  );

  it("webhooks-callbacks.bdd-046 (2/2) updates concurrency add-on across past_due, cancel_at_period_end, item removal, and deletion", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;

    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }
    webhooks.configureStripeBillingEnv();
    const { customerId } = await runs.grantProEntitlement(member, {
      periodEndUnix: periodEnd,
    });

    const concSubId = stripeId("sub_conc_lifecycle");
    const concSub = (
      quantity: number,
      overrides: {
        readonly status?: string;
        readonly cancelAtPeriodEnd?: boolean;
        readonly emptyItems?: boolean;
      } = {},
    ) => {
      const base = stripeSubscriptionObject({
        id: concSubId,
        customerId,
        priceId: "price_bdd_concurrency",
        status: overrides.status ?? "active",
        periodStart: startSec,
        periodEnd,
        quantity,
        cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
        metadata: { purpose: "concurrency_subscription" },
      });
      return overrides.emptyItems ? { ...base, items: { data: [] } } : base;
    };

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(concSub(2));

    const postFastStripe200 = async (
      event: Readonly<Record<string, unknown>>,
    ) => {
      webhooks.acceptNextStripeWebhookEvent(event);
      await accept(
        webhooksStripeApi.post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
        }),
        [200],
      );
    };
    signInWithProfile(member);
    const readFastBillingAndQueue = async () => {
      const [statusRes, queueRes] = await Promise.all([
        accept(billingStatusApi.get({ headers: SESSION_HEADERS }), [200]),
        accept(runsQueueApi.getQueue({ headers: SESSION_HEADERS }), [200]),
      ]);
      return { billing: statusRes.body, queue: queueRes.body };
    };
    const readFastBilling = async () => {
      const statusRes = await accept(
        billingStatusApi.get({ headers: SESSION_HEADERS }),
        [200],
      );
      return statusRes.body;
    };

    await postFastStripe200(
      stripeEvent("customer.subscription.created", concSub(2)),
    );
    await postFastStripe200(
      stripeEvent("invoice.paid", {
        id: stripeId("in_conc_lifecycle"),
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concSubId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: "price_bdd_concurrency" },
              quantity: 2,
              amount: 200,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
          ],
        },
      }),
    );

    const pastDueSub = concSub(2, { status: "past_due" });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(pastDueSub);
    await postFastStripe200(
      stripeEvent("customer.subscription.updated", pastDueSub),
    );
    const afterPastDue = await readFastBillingAndQueue();
    expect(afterPastDue.billing.concurrencySubscriptions).toMatchObject([
      { id: concSubId, quantity: 2 },
    ]);
    expect(afterPastDue.queue.concurrency.limit).toBe(5);

    const cancelSetSub = concSub(2, { cancelAtPeriodEnd: true });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(cancelSetSub);
    await postFastStripe200(
      stripeEvent("customer.subscription.updated", cancelSetSub),
    );
    expect((await readFastBilling()).concurrencySubscriptions).toMatchObject([
      { id: concSubId, cancelAtPeriodEnd: true },
    ]);

    const cancelClearedSub = concSub(2, { cancelAtPeriodEnd: false });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelClearedSub,
    );
    await postFastStripe200(
      stripeEvent("customer.subscription.updated", cancelClearedSub),
    );
    expect((await readFastBilling()).concurrencySubscriptions).toMatchObject([
      { id: concSubId, cancelAtPeriodEnd: false },
    ]);

    const emptySub = concSub(0, { emptyItems: true });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(emptySub);
    await postFastStripe200(
      stripeEvent("customer.subscription.updated", emptySub),
    );
    const afterEmpty = await readFastBillingAndQueue();
    expect(afterEmpty.billing.concurrencySubscriptions).toStrictEqual([]);
    expect(afterEmpty.queue.concurrency.limit).toBe(3);

    const deletedSub = concSub(0, { status: "canceled", emptyItems: true });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(deletedSub);
    await postFastStripe200(
      stripeEvent("customer.subscription.deleted", deletedSub),
    );
    const afterDelete = await readFastBillingAndQueue();
    expect(afterDelete.billing).toMatchObject({
      tier: "pro",
      hasSubscription: true,
      concurrencySubscriptions: [],
    });
    expect(afterDelete.queue.concurrency.limit).toBe(3);
  });

  it(
    "webhooks-callbacks.bdd-055 revokes deleted-user pending inputs without launching them when capacity returns and retains shared history",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const startSec = Math.floor(startMs / 1000);
      const runner = createDirectRunnerForRunTests();
      const admin = bdd.user({ orgRole: "org:admin" });
      const peer = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
      const orgId = admin.orgId;
      if (!orgId) {
        throw new Error("Expected admin orgId");
      }
      webhooks.configureClerkWebhookSecret();
      webhooks.configureStripeBillingEnv();

      await Promise.all([
        runs.grantProEntitlement(admin, {
          periodEndUnix: startSec + 30 * DAY_SECONDS,
        }),
        runner.registerRunner(),
        runner.addClaudeProvider(admin),
      ]);

      const adminRuns = await runner.launchRunsParallel(admin, [
        "Admin running 1",
        "Admin running 2",
        "Admin running 3",
      ]);
      const [, firstThreadEvents] = await Promise.all([
        runner.sendChatInput(admin, {
          prompt: "Admin queued input that must be revoked on user.deleted",
          model: CLAUDE_MODEL,
        }),
        chatFiles.listThreadEvents(admin, adminRuns[0]?.threadId ?? ""),
      ]);
      const promptEventId = firstThreadEvents.events.find((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      })?.id;
      if (!promptEventId) {
        throw new Error("Expected input.prompt event to share");
      }
      signInWithProfile(admin);
      const sharedCreated = await accept(
        sharedThreadsApi.create({
          headers: SESSION_HEADERS,
          params: { threadId: adminRuns[0]?.threadId ?? "" },
          body: { eventIds: [promptEventId] },
        }),
        [201],
      );
      const [sharedBefore] = await Promise.all([
        accept(
          sharedThreadsApi.get({ params: { id: sharedCreated.body.id } }),
          [200],
        ),
        bdd.completeOnboarding(peer),
      ]);
      await runner.addClaudeProvider(peer);
      await runner.sendChatInput(peer, {
        prompt: "Peer queued input waiting at org capacity",
        model: CLAUDE_MODEL,
      });
      await flushWaitUntilForTest();
      expect(runner.acceptedOrder).toHaveLength(3);

      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              role: "org:member",
              organization: { id: orgId },
              publicUserData: { userId: peer.userId },
            },
          ],
        },
      );

      webhooks.verifyNextClerkWebhook({
        type: "user.deleted",
        data: { id: admin.userId },
      });
      const deleted = await webhooks.requestClerkWebhook("{}", {}, [200]);
      expect(deleted.body).toBe("OK");
      await flushWaitUntilForTest();

      await Promise.all(
        adminRuns.map(async (entry) => {
          await accept(
            webhooksAgentCompleteApi.complete({
              headers: sandboxHeaders(entry.execution.sandboxToken),
              body: {
                runId: entry.runId,
                exitCode: 137,
                error: "Deleted user run stopped",
              },
            }),
            [200],
          );
          entry.trackedEntry.done = true;
        }),
      );
      await flushWaitUntilForTest();

      expect(runner.acceptedOrder).toHaveLength(4);
      const peerPickedRunId = runner.acceptedOrder[3];
      if (!peerPickedRunId) {
        throw new Error("Expected peer queued input to start after deletion");
      }
      const peerPickedExec = runner.acceptedByRunId.get(peerPickedRunId);
      if (!peerPickedExec) {
        throw new Error("Missing execution context for peer queued run");
      }
      runner.trackExecution(peer, peerPickedExec);

      signInWithProfile(peer);
      const [peerPickedRun] = await Promise.all([
        accept(
          runsByIdApi.getById({
            headers: SESSION_HEADERS,
            params: { id: peerPickedRunId },
          }),
          [200],
        ),
        runner.launchRun(peer, {
          prompt: "Peer second thread run after admin deletion",
          model: CLAUDE_MODEL,
        }),
      ]);
      expect(peerPickedRun.body.status).toBe("running");

      const [queueAfter, sharedAfter] = await Promise.all([
        readRunQueue(peer),
        accept(
          sharedThreadsApi.get({ params: { id: sharedCreated.body.id } }),
          [200],
        ),
      ]);
      expect(queueAfter.concurrency.active).toBe(2);
      expect(queueAfter.concurrency.memberUsage).toContainEqual(
        expect.objectContaining({
          userId: peer.userId,
          active: 2,
        }),
      );
      const deletedAdminUsage = queueAfter.concurrency.memberUsage.find(
        (entry) => {
          return entry.userId === admin.userId;
        },
      );
      expect(deletedAdminUsage?.active ?? 0).toBe(0);
      expect(sharedAfter.body).toStrictEqual(sharedBefore.body);
    },
  );

  it(
    "webhooks-agent-session-output-004 rejects body-supplied channel authority",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const startSec = Math.floor(startMs / 1000);
      const runner = createDirectRunnerForRunTests();
      const member = bdd.user({ orgRole: "org:admin" });
      const other = bdd.user({ orgRole: "org:admin" });
      if (!other.orgId) {
        throw new Error("Expected other orgId");
      }
      webhooks.configureStripeBillingEnv();

      await Promise.all([
        runs.grantProEntitlement(member, {
          periodEndUnix: startSec + 30 * DAY_SECONDS,
        }),
        runner.registerRunner(),
      ]);
      await runner.addClaudeProvider(member);

      const launched = await runner.launchRun(member, {
        prompt: "Session output body channel authority rejection",
        model: CLAUDE_MODEL,
      });

      const channelGetCallsBefore =
        context.mocks.ably.channelGet.mock.calls.length;
      const publishCallsBefore = context.mocks.ably.publish.mock.calls.length;
      const batchPublishCallsBefore =
        context.mocks.ably.batchPublish.mock.calls.length;

      const response = await webhooksAgentSessionOutputRaw(
        "/api/webhooks/run/session-output",
        {
          method: "POST",
          headers: {
            ...sandboxHeaders(launched.execution.sandboxToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: launched.runId,
            threadId: launched.threadId,
            runEventId: `evt-${randomUUID()}`,
            chunkIndex: 0,
            delta: "visible delta",
            userId: other.userId,
            orgId: other.orgId,
            channel: `run-output:${other.userId}:${other.orgId}:${launched.runId}`,
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(context.mocks.ably.channelGet.mock.calls).toHaveLength(
        channelGetCallsBefore,
      );
      expect(context.mocks.ably.publish.mock.calls).toHaveLength(
        publishCallsBefore,
      );
      expect(context.mocks.ably.batchPublish.mock.calls).toHaveLength(
        batchPublishCallsBefore,
      );
    },
  );
});
