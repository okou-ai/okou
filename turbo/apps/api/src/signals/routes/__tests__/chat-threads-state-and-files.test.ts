import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  chatEventsContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadPinOrderContract,
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { comparePinnedThreads } from "@okouai/core/chat-thread-pin-order";
import { beforeAll, describe, expect, it } from "vitest";
import { boolean, literal, object as zObject } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { logsRoutes } from "../logs";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  executionEnvironment,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const webhookResponseSchema = zObject({
  success: literal(true),
  duplicate: boolean(),
});

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const routeMocks = createRouteMocks(context);

const chatApp = setupApp({
  context,
  routes: chatThreadRoutes,
});
const chatThreadsClient = chatApp(chatThreadsContract);
const chatThreadDraftClient = chatApp(chatThreadDraftContract);
const chatThreadEventsClient = chatApp(chatThreadEventsContract);
const chatThreadMetadataClient = chatApp(chatThreadMetadataContract);
const chatThreadModelSelectionClient = chatApp(
  chatThreadModelSelectionContract,
);
const chatThreadPinClient = chatApp(chatThreadPinContract);
const chatThreadPinOrderClient = chatApp(chatThreadPinOrderContract);

const onboardingCompleteClient = setupApp({
  context,
  routes: onboardingCompleteRoutes,
})(onboardingCompleteContract);
const runnersHeartbeatClient = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const chatEventsClient = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const uploadsClient = setupApp({
  context,
  routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
})(uploadsContract);
const personalModelProvidersClient = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const workflowsCollectionClient = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);
const workflowAutomationsClient = setupApp({
  context,
  routes: workflowAutomationsRoutes,
})(workflowAutomationsContract);
const workflowWebhookRequest = setupRawAppRequest({
  context,
  routes: webhooksWorkflowAutomationsRoutes,
});
const webhookEventsClient = setupApp({
  context,
  routes: webhooksAgentEventsRoutes,
})(webhookEventsContract);
const webhookCompleteClient = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const webhookClerkClient = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const webhookStripeClient = setupApp({
  context,
  routes: webhooksStripeRoutes,
})(webhookStripeContract);
const runsByIdClient = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelClient = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const logsListClient = setupApp({
  context,
  routes: logsRoutes,
})(logsListContract);

function signIn(user: ApiTestUser) {
  routeMocks.clerk.session(user.userId, user.orgId, user.orgRole);
  return SESSION_HEADERS;
}

function bearerHeaders(token: string) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  return { authorization: `Bearer ${token}` } as const;
}

function textUserMessage(text: string) {
  return {
    version: 1 as const,
    parts: [{ type: "text" as const, text }],
  };
}

async function listProjectedEvents(
  actor: ApiTestUser,
  threadId: string,
): Promise<readonly ChatEvent[]> {
  const response = await accept(
    chatThreadEventsClient.rows({
      headers: signIn(actor),
      params: { threadId },
      query: { sinceSeqId: 0 },
    }),
    [200],
  );
  return projectChatEventRows(response.body.rows);
}

async function upsertClaudeProvider(actor: ApiTestUser): Promise<void> {
  await accept(
    personalModelProvidersClient.upsert({
      headers: signIn(actor),
      body: {
        type: "claude-code-oauth-token",
        secret: `claude-token-${randomUUID()}`,
      },
    }),
    [201],
  );
}

async function launchChatRun(
  actor: ApiTestUser,
  args: { readonly prompt: string; readonly model: string | null },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const clientEventId = randomUUID();
  const sent = await accept(
    chatEventsClient.send({
      headers: signIn(actor),
      body: {
        prompt: args.prompt,
        model: args.model,
        clientEventId,
        hasTextContent: true,
        userMessage: textUserMessage(args.prompt),
      },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  const events = await listProjectedEvents(actor, sent.body.threadId);
  const launched = events.find((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.revokesEventId === clientEventId &&
      event.runId !== undefined
    );
  });
  if (!launched?.runId) {
    throw new Error("Expected chat send to launch a run");
  }
  return { runId: launched.runId, threadId: sent.body.threadId };
}

function configureRunBoundaries(openrouterKey?: string): () => void {
  const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
  const captured = captureConnectorExternalState(context, [
    "OPENROUTER_API_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "OKOU_PRICE_PRO",
    "OKOU_PRICE_TEAM",
    "OKOU_PRICE_CONCURRENCY",
    "OKOU_ONE_TIME_CAMPAIGN",
  ]);
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", openrouterKey);
  return () => {
    captured();
    mockOptionalEnv("OPENROUTER_API_KEY", previousOpenrouterKey);
  };
}

async function grantPaidPlan(
  actor: ApiTestUser,
  tier: "pro" | "team",
): Promise<void> {
  webhooks.configureStripeBillingEnv();
  const priceId = tier === "team" ? "price_bdd_team" : "price_bdd_pro";
  const suffix = randomUUID();
  const customerId = `cus_bdd_${suffix}`;
  const subscriptionId = `sub_bdd_${suffix}`;
  const periodEndUnix = Math.floor(now() / 1000) + 30 * 86_400;
  const customer = {
    id: customerId,
    object: "customer",
    metadata: { orgId: actor.orgId },
  };
  const subscription = {
    id: subscriptionId,
    object: "subscription",
    status: "active",
    customer: customerId,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      object: "list",
      has_more: false,
      url: `/v1/subscription_items?subscription=${subscriptionId}`,
      data: [
        {
          id: `si_bdd_${suffix}`,
          object: "subscription_item",
          price: { id: priceId, object: "price" },
          current_period_start: periodEndUnix - 30 * 86_400,
          current_period_end: periodEndUnix,
        },
      ],
    },
  };
  const invoicePaidEvent = {
    id: `evt_bdd_${suffix}`,
    object: "event",
    created: Math.floor(now() / 1000),
    type: "invoice.paid",
    data: {
      object: {
        id: `in_bdd_${suffix}`,
        object: "invoice",
        customer: customerId,
        metadata: {},
        parent: { subscription_details: { subscription: subscriptionId } },
        lines: {
          has_more: false,
          data: [
            {
              price: { id: priceId },
              parent: { type: "subscription_item_details" },
              period: {
                start: periodEndUnix - 30 * 86_400,
                end: periodEndUnix,
              },
            },
          ],
        },
      },
    },
  };
  context.mocks.stripe.customers.retrieve.mockResolvedValue(customer);
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  if (tier === "team") {
    context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
  }
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
    invoicePaidEvent,
  );
  await accept(
    webhookStripeClient.post({
      body: JSON.stringify(invoicePaidEvent),
      extraHeaders: { "stripe-signature": "t=1,v1=bdd" },
    }),
    [200],
  );
  if (tier === "team") {
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organization.created",
      data: {
        id: actor.orgId,
        created_by: actor.userId,
        created_at: now(),
      },
    });
  }
  await Promise.all([
    accept(
      onboardingCompleteClient.complete({
        headers: signIn(actor),
        body: {},
      }),
      [200],
    ),
    ...(tier === "team"
      ? [
          accept(
            webhookClerkClient.post({
              body: "{}",
              extraHeaders: {},
            }),
            [200],
          ),
        ]
      : []),
  ]);
}

async function prepareLimitedFreeRunActor(
  options: {
    readonly includeClaude?: boolean;
    readonly openrouterKey?: string;
  } = {},
) {
  const actor = bdd.user();
  const restoreEnvironment = configureRunBoundaries(options.openrouterKey);
  const owner = publicRunOwner(context, actor, { restoreEnvironment });
  if (options.includeClaude) {
    mockClaudeCodeTokenEndpoint();
  }
  await owner.run(async () => {
    await Promise.all([
      bdd.bootstrapLimitedFreeOnboarding(actor),
      runs.configureRunnerGroup(),
      ...(options.includeClaude ? [upsertClaudeProvider(actor)] : []),
    ]);
  });
  return { actor, owner };
}

async function preparePaidClaudeRunActor(tier: "pro" | "team") {
  const actor = bdd.user();
  const restoreEnvironment = configureRunBoundaries(undefined);
  const owner = publicRunOwner(context, actor, { restoreEnvironment });
  mockClaudeCodeTokenEndpoint();
  await owner.run(async () => {
    await Promise.all([
      runs.configureRunnerGroup(),
      grantPaidPlan(actor, tier),
      upsertClaudeProvider(actor),
    ]);
  });
  return { actor, owner };
}

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  const warmupThreadId = randomUUID();
  const warmupRunId = randomUUID();
  const warmupWorkflowId = randomUUID();
  await Promise.all([
    accept(onboardingCompleteClient.complete({ headers: {}, body: {} }), [401]),
    accept(
      runnersHeartbeatClient.heartbeat({
        headers: {},
        body: {
          runnerId: randomUUID(),
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
        },
      }),
      [401],
    ),
    accept(
      chatEventsClient.send({
        headers: {},
        body: {
          prompt: "warmup",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: textUserMessage("warmup"),
        },
      }),
      [401],
    ),
    accept(
      chatThreadsClient.create({
        headers: {},
        body: { title: "warmup", model: null },
      }),
      [401],
    ),
    accept(
      chatThreadDraftClient.readComposer({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadEventsClient.rows({
        headers: {},
        params: { threadId: warmupThreadId },
        query: { sinceSeqId: 0 },
      }),
      [401],
    ),
    accept(
      chatThreadMetadataClient.get({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadModelSelectionClient.update({
        headers: {},
        params: { id: warmupThreadId },
        body: { model: null },
      }),
      [401],
    ),
    accept(
      chatThreadPinClient.pin({
        headers: {},
        params: { id: warmupThreadId },
        query: {},
      }),
      [401],
    ),
    accept(
      chatThreadPinOrderClient.reorder({
        headers: {},
        params: { id: warmupThreadId },
        body: { pinOrder: "a0", eventId: randomUUID() },
      }),
      [401],
    ),
    accept(
      uploadsClient.prepare({
        headers: {},
        body: {
          filename: "warmup.txt",
          contentType: "text/plain",
          size: 12,
        },
      }),
      [401],
    ),
    accept(
      uploadsClient.complete({
        headers: {},
        body: { id: randomUUID() },
      }),
      [401],
    ),
    accept(
      personalModelProvidersClient.upsert({
        headers: {},
        body: { type: "claude-code-oauth-token", secret: "warmup" },
      }),
      [401],
    ),
    accept(
      workflowsCollectionClient.create({
        headers: {},
        body: { name: "warmup-workflow", visibility: "public" },
      }),
      [401],
    ),
    accept(
      workflowAutomationsClient.create({
        headers: {},
        params: { workflowId: warmupWorkflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [401],
    ),
    workflowWebhookRequest("/api/webhooks/workflow-automations/warmup-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    accept(
      webhookEventsClient.send({
        headers: {},
        body: {
          runId: warmupRunId,
          events: [{ type: "assistant", sequenceNumber: 1 }],
        },
      }),
      [401],
    ),
    accept(
      webhookCompleteClient.complete({
        headers: {},
        body: { runId: warmupRunId, exitCode: 0 },
      }),
      [401],
    ),
    accept(
      webhookClerkClient.post({
        body: "{}",
        extraHeaders: {},
      }),
      [401],
    ),
    accept(
      webhookStripeClient.post({
        body: "{}",
        extraHeaders: {},
      }),
      [401, 503],
    ),
    accept(
      runsByIdClient.getById({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
    accept(
      runsCancelClient.cancel({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
    accept(
      logsListClient.list({
        headers: {},
        query: { limit: 1 },
      }),
      [401],
    ),
  ]);
});

describe("conversation history deletion", () => {
  it(
    "conversation-history-deletion-001 preserves completed Run history and callback replay after Clerk user deletion",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await preparePaidClaudeRunActor("pro");

      const launched = await launchChatRun(actor, {
        prompt: "Archive completed Claude Code session",
        model: "claude-fable-5-1",
      });
      const execution = await owner.executionInput(launched.runId);
      expect(execution.cliAgentType).toBe("claude-code");
      const sandboxHeaders = {
        authorization: `Bearer ${execution.sandboxToken}`,
      };

      const completionBody = {
        runId: launched.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "claude-code" as const,
          cliAgentSessionId: `claude-session-${launched.runId}`,
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };
      await accept(
        webhookCompleteClient.complete({
          headers: sandboxHeaders,
          body: completionBody,
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const beforeDeletion = await accept(
        runsByIdClient.getById({
          headers: signIn(actor),
          params: { id: launched.runId },
        }),
        [200],
      );
      expect(beforeDeletion.body.status).toBe("completed");

      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
        type: "user.deleted",
        data: { id: actor.userId, deleted: true },
      });
      const deletionResponse = await accept(
        webhookClerkClient.post({
          body: "{}",
          extraHeaders: {},
        }),
        [200],
      );
      expect(deletionResponse.status).toBe(200);
      await flushWaitUntilForTest();

      const replayResponse = await accept(
        webhookCompleteClient.complete({
          headers: sandboxHeaders,
          body: completionBody,
        }),
        [200],
      );
      expect(replayResponse.status).toBe(200);
      await flushWaitUntilForTest();
    },
  );
});

describe("public selection of a retired model for webhook automation", () => {
  it(
    "chat-thread-stored-selection-001 normalizes an explicit thread selection and runs its webhook automation on the successor",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await preparePaidClaudeRunActor("team");

      const createdWorkflow = await accept(
        workflowsCollectionClient.create({
          headers: signIn(actor),
          body: {
            name: `retired-webhook-${randomUUID().slice(0, 8)}`,
            visibility: "public",
          },
        }),
        [201],
      );
      const createdAutomation = await accept(
        workflowAutomationsClient.create({
          headers: signIn(actor),
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
        throw new Error("Expected a thread-bound signed webhook automation");
      }
      const threadId = automation.chatThreadId;

      await accept(
        chatThreadModelSelectionClient.update({
          headers: signIn(actor),
          params: { id: threadId },
          body: { model: "claude-fable-5" },
        }),
        [204],
      );

      const rawBody = JSON.stringify({ event: "trigger-retired-selection" });
      const timestamp = Math.floor(now() / 1000);
      const webhookResponse = await workflowWebhookRequest(
        new URL(automation.webhookUrl).pathname,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Okou-Timestamp": String(timestamp),
            "X-Okou-Signature": computeHmacSignature(
              rawBody,
              automation.webhookSecret,
              timestamp,
            ),
          },
          body: rawBody,
        },
      );
      expect(webhookResponse.status).toBe(200);
      const parsedWebhook = webhookResponseSchema.parse(webhookResponse.body);
      expect(parsedWebhook).toStrictEqual({ success: true, duplicate: false });

      await flushWaitUntilForTest();
      const [threadEvents, metadata, feed] = await Promise.all([
        listProjectedEvents(actor, threadId),
        accept(
          chatThreadMetadataClient.get({
            headers: signIn(actor),
            params: { id: threadId },
          }),
          [200],
        ),
        accept(
          chatThreadsClient.events({
            headers: signIn(actor),
            query: {},
          }),
          [200],
        ),
      ]);
      const launchedEvent = threadEvents.find((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      });
      if (!launchedEvent?.runId) {
        throw new Error("Expected the webhook automation to launch a run");
      }

      const execution = await owner.executionInput(launchedEvent.runId);
      expect(executionEnvironment(execution).ANTHROPIC_MODEL).toBe(
        "claude-fable-5-1",
      );
      expect(metadata.body.selectedModel).toBe("claude-fable-5-1");
      const modelUpdates = feed.body.events.filter((event) => {
        return (
          event.chatThreadId === threadId &&
          event.kind === "model_selection_updated"
        );
      });
      expect(modelUpdates).toHaveLength(1);
      expect(modelUpdates[0]).toMatchObject({
        kind: "model_selection_updated",
        chatThreadId: threadId,
        selectedModel: "claude-fable-5-1",
      });
    },
  );
});

describe("chat messages and visible validation", () => {
  it("chat-files.bdd-004 (1/3) records no-credit rejection and empty draft for a file-backed user message", async () => {
    const member = bdd.user();
    bdd.acceptStorageWrites();

    const prepared = await accept(
      uploadsClient.prepare({
        headers: signIn(member),
        body: {
          filename: "launch-plan.txt",
          contentType: "text/plain",
          size: 24,
        },
      }),
      [200],
    );
    if ("multipart" in prepared.body) {
      throw new Error("Expected a single-part upload");
    }
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentLength: 24,
          LastModified: nowDate(),
        });
      }
      if (command instanceof GetObjectCommand) {
        if (!command.input.Key?.startsWith("private-artifacts/")) {
          return Promise.reject(
            Object.assign(new Error("Missing object"), { name: "NoSuchKey" }),
          );
        }
        return Promise.resolve({
          ContentLength: 24,
          LastModified: nowDate(),
          Body: Readable.from([Buffer.alloc(24, 0x61)]),
        });
      }
      if (command instanceof PutObjectCommand) {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });
    const completed = await accept(
      uploadsClient.complete({
        headers: signIn(member),
        body: { id: prepared.body.id },
      }),
      [200],
    );

    const clientEventId = randomUUID();
    const userMessage = {
      version: 1 as const,
      parts: [
        { type: "text" as const, text: "Review launch plan" },
        {
          type: "file" as const,
          fileId: completed.body.id,
          filenameSnapshot: "launch-plan.txt",
          contentType: "text/plain",
        },
      ],
    };

    const firstSend = await accept(
      chatEventsClient.send({
        headers: signIn(member),
        body: {
          prompt: "Review launch plan",
          model: null,
          clientEventId,
          hasTextContent: true,
          userMessage,
        },
      }),
      [201],
    );
    expect(firstSend.status).toBe(201);
    const threadId = firstSend.body.threadId;
    expect(threadId).toBeTruthy();
    await flushWaitUntilForTest();

    const [draft, events] = await Promise.all([
      accept(
        chatThreadDraftClient.readComposer({
          headers: signIn(member),
          params: { id: threadId },
        }),
        [200],
      ),
      listProjectedEvents(member, threadId),
    ]);
    expect(draft.body).toMatchObject({
      draftUserMessage: null,
      draftAttachments: null,
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      id: clientEventId,
      eventType: "input.prompt",
      userMessage,
    });
    expect(events[1]).toMatchObject({
      eventType: "input.rejected",
      revokesEventId: clientEventId,
      error: "insufficient_credits",
    });
    expect(events[2]).toMatchObject({
      eventType: "output.error",
    });
    const outputError = events[2];
    if (outputError?.eventType !== "output.error") {
      throw new Error("Expected an output.error event");
    }
    expect(outputError.content).toContain("Insufficient credits");
  });

  it("chat-files.bdd-004 (2/3) deduplicates retried and cross-thread clientEventId and rejects unknown-run interrupts", async () => {
    const member = bdd.user();
    const clientEventId = randomUUID();
    const userMessage = textUserMessage("Deduplicate launch message");

    const [firstSend, secondThread] = await Promise.all([
      accept(
        chatEventsClient.send({
          headers: signIn(member),
          body: {
            prompt: "Deduplicate launch message",
            model: null,
            clientEventId,
            hasTextContent: true,
            userMessage,
          },
        }),
        [201],
      ),
      accept(
        chatThreadsClient.create({
          headers: signIn(member),
          body: { title: "Second thread", model: null },
        }),
        [201],
      ),
    ]);
    const threadId = firstSend.body.threadId;
    await flushWaitUntilForTest();

    const [retrySend, crossThreadReuse, unknownInterrupt] = await Promise.all([
      accept(
        chatEventsClient.send({
          headers: signIn(member),
          body: {
            threadId,
            prompt: "Deduplicate launch message",
            clientEventId,
            hasTextContent: true,
            userMessage,
          },
        }),
        [201],
      ),
      accept(
        chatEventsClient.send({
          headers: signIn(member),
          body: {
            threadId: secondThread.body.id,
            prompt: "Reuse client event id",
            clientEventId,
            hasTextContent: true,
            userMessage: textUserMessage("Reuse client event id"),
          },
        }),
        [201],
      ),
      accept(
        chatEventsClient.send({
          headers: signIn(member),
          body: {
            threadId,
            interruptsRunId: randomUUID(),
          },
        }),
        [400],
      ),
    ]);
    expect(retrySend.status).toBe(201);
    expect(retrySend.body.threadId).toBe(threadId);
    expect(crossThreadReuse.status).toBe(201);
    expect(unknownInterrupt.body.error.code).toBe("BAD_REQUEST");
    expect(unknownInterrupt.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );
    await flushWaitUntilForTest();

    const [firstThreadEvents, secondThreadEvents] = await Promise.all([
      listProjectedEvents(member, threadId),
      listProjectedEvents(member, secondThread.body.id),
    ]);
    expect(firstThreadEvents).toHaveLength(3);
    expect(secondThreadEvents).toStrictEqual([]);
  });

  it("chat-files.bdd-004 (3/3) rejects stale follow-ups and enforces recall ownership and idempotency on rejected inputs", async () => {
    const member = bdd.user();
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
    const clientEventId = randomUUID();

    const sent = await accept(
      chatEventsClient.send({
        headers: signIn(member),
        body: {
          prompt: "Draft launch checklist",
          model: null,
          clientEventId,
          hasTextContent: true,
          userMessage: textUserMessage("Draft launch checklist"),
        },
      }),
      [201],
    );
    const threadId = sent.body.threadId;
    await flushWaitUntilForTest();

    const initialEvents = await listProjectedEvents(member, threadId);
    const rejectedInput = initialEvents.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === clientEventId
      );
    });
    if (!rejectedInput) {
      throw new Error("Expected an insufficient_credits rejected input event");
    }

    const staleFollowup = await accept(
      chatEventsClient.send({
        headers: signIn(member),
        body: {
          threadId,
          prompt: "Try stale recommended follow-up",
          revokesEventId: rejectedInput.id,
          hasTextContent: true,
          userMessage: textUserMessage("Try stale recommended follow-up"),
        },
      }),
      [400],
    );
    expect(staleFollowup.body.error.code).toBe("BAD_REQUEST");
    expect(staleFollowup.body.error.message).toBe(
      "Recommended follow-up is no longer available",
    );

    const peerRecall = await accept(
      chatEventsClient.send({
        headers: signIn(peer),
        body: {
          threadId,
          revokesEventId: rejectedInput.id,
        },
      }),
      [404],
    );
    expect(peerRecall.body.error.code).toBe("NOT_FOUND");

    const firstRecall = await accept(
      chatEventsClient.send({
        headers: signIn(member),
        body: {
          threadId,
          revokesEventId: rejectedInput.id,
        },
      }),
      [201],
    );
    expect(firstRecall.status).toBe(201);

    const secondRecall = await accept(
      chatEventsClient.send({
        headers: signIn(member),
        body: {
          threadId,
          revokesEventId: rejectedInput.id,
        },
      }),
      [201],
    );
    expect(secondRecall.status).toBe(201);
    await flushWaitUntilForTest();

    const afterRecalls = await listProjectedEvents(member, threadId);
    const revokers = afterRecalls.filter((event) => {
      return (
        event.eventType === "control.revoke" &&
        event.revokesEventId === rejectedInput.id
      );
    });
    expect(revokers).toHaveLength(1);
  });
});

describe("chat indicator realtime signal", () => {
  it(
    "chat-indicators-realtime-001 signals a Run start and its terminal marker but not its output",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeRunActor({
        includeClaude: true,
      });
      if (!actor.orgId) {
        throw new Error("Expected owner orgId");
      }
      const userOrgChannel = `user-org:${actor.userId}:${actor.orgId}`;

      await flushWaitUntilForTest();
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();

      const launched = await launchChatRun(actor, {
        prompt: "Track chat indicator signals",
        model: "claude-fable-5-1",
      });
      expect(
        countPublishedTo(context.mocks, {
          channel: userOrgChannel,
          topic: "chatIndicatorsChanged",
        }),
      ).toBe(1);

      const execution = await owner.executionInput(launched.runId);
      const sandboxHeaders = {
        authorization: `Bearer ${execution.sandboxToken}`,
      };
      const sessionId = `claude-session-${launched.runId}`;

      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();

      const outputCallback = await accept(
        webhookEventsClient.send({
          headers: sandboxHeaders,
          body: {
            runId: launched.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: sessionId,
                sequenceNumber: 1,
              },
              {
                type: "assistant",
                sequenceNumber: 2,
                message: {
                  content: [{ type: "text", text: "Progress update" }],
                },
              },
            ],
          },
        }),
        [200],
      );
      expect(outputCallback.status).toBe(200);
      await flushWaitUntilForTest();

      expect(
        countPublishedTo(context.mocks, {
          channel: userOrgChannel,
          topic: `chatThreadMessageCreated:${launched.threadId}`,
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        countPublishedTo(context.mocks, {
          channel: userOrgChannel,
          topic: "chatIndicatorsChanged",
        }),
      ).toBe(0);

      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();

      const terminalCallback = await accept(
        webhookCompleteClient.complete({
          headers: sandboxHeaders,
          body: {
            runId: launched.runId,
            exitCode: 0,
            lastEventSequence: 2,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: sessionId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      expect(terminalCallback.status).toBe(200);
      await flushWaitUntilForTest();

      expect(
        countPublishedTo(context.mocks, {
          channel: userOrgChannel,
          topic: "chatIndicatorsChanged",
        }),
      ).toBe(1);
      const completedRun = await accept(
        runsByIdClient.getById({
          headers: signIn(actor),
          params: { id: launched.runId },
        }),
        [200],
      );
      expect(completedRun.body.status).toBe("completed");
    },
  );
});

describe("retired model selection with a workspace Run token", () => {
  it(
    "chat-threads-model-selection-009 stores and records the replacement when an old client requests retired claude-fable-5",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeRunActor({
        includeClaude: true,
        openrouterKey: "bdd-retired-selection-key",
      });

      const [launched, ownedThread] = await Promise.all([
        launchChatRun(actor, {
          prompt: "Issue workspace run token",
          model: null,
        }),
        accept(
          chatThreadsClient.create({
            headers: signIn(actor),
            body: { title: "Legacy model thread", model: null },
          }),
          [201],
        ),
      ]);
      const execution = await owner.executionInput(launched.runId);
      const runToken = okouTokenFromExecution(execution);

      const writeResponse = await accept(
        chatThreadModelSelectionClient.update({
          headers: bearerHeaders(runToken),
          params: { id: ownedThread.body.id },
          body: { model: "claude-fable-5" },
        }),
        [204],
      );
      expect(writeResponse.status).toBe(204);

      const [metadataResponse, eventsResponse] = await Promise.all([
        accept(
          chatThreadMetadataClient.get({
            headers: bearerHeaders(runToken),
            params: { id: ownedThread.body.id },
          }),
          [200],
        ),
        accept(
          chatThreadsClient.events({
            headers: bearerHeaders(runToken),
            query: {},
          }),
          [200],
        ),
      ]);
      expect(metadataResponse.status).toBe(200);
      expect(eventsResponse.status).toBe(200);
      expect(metadataResponse.body.selectedModel).toBe("claude-fable-5-1");

      const modelEvents = eventsResponse.body.events.filter((event) => {
        return (
          event.chatThreadId === ownedThread.body.id &&
          event.kind === "model_selection_updated"
        );
      });
      expect(modelEvents).toHaveLength(1);
      expect(modelEvents[0]).toMatchObject({
        kind: "model_selection_updated",
        chatThreadId: ownedThread.body.id,
        selectedModel: "claude-fable-5-1",
      });
    },
  );
});

describe("pinned thread ordering", () => {
  it(
    "chat-threads-pin-order-001 persists client ranks in events without changing pin time",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeRunActor({
        openrouterKey: "bdd-pin-order-key",
      });

      const [launched, firstThread, secondThread] = await Promise.all([
        launchChatRun(actor, {
          prompt: "Issue run token for pin reorder",
          model: null,
        }),
        accept(
          chatThreadsClient.create({
            headers: signIn(actor),
            body: { title: "First pinned", model: null },
          }),
          [201],
        ),
        accept(
          chatThreadsClient.create({
            headers: signIn(actor),
            body: { title: "Second pinned", model: null },
          }),
          [201],
        ),
      ]);
      const [execution] = await Promise.all([
        owner.executionInput(launched.runId),
        accept(
          chatThreadPinClient.pin({
            headers: signIn(actor),
            params: { id: firstThread.body.id },
            query: { pinOrder: "a1" },
          }),
          [204],
        ),
        accept(
          chatThreadPinClient.pin({
            headers: signIn(actor),
            params: { id: secondThread.body.id },
            query: { pinOrder: "a0" },
          }),
          [204],
        ),
      ]);
      const runToken = okouTokenFromExecution(execution);

      const metadataBefore = await accept(
        chatThreadMetadataClient.get({
          headers: bearerHeaders(runToken),
          params: { id: firstThread.body.id },
        }),
        [200],
      );
      expect(metadataBefore.body.pinnedAt).toBeTruthy();

      const reorderEventId = randomUUID();
      const reorderResponse = await accept(
        chatThreadPinOrderClient.reorder({
          headers: bearerHeaders(runToken),
          params: { id: firstThread.body.id },
          body: { pinOrder: "Zy", eventId: reorderEventId },
        }),
        [204],
      );
      expect(reorderResponse.status).toBe(204);

      const [metadataAfter, eventsResponse] = await Promise.all([
        accept(
          chatThreadMetadataClient.get({
            headers: bearerHeaders(runToken),
            params: { id: firstThread.body.id },
          }),
          [200],
        ),
        accept(
          chatThreadsClient.events({
            headers: bearerHeaders(runToken),
            query: {},
          }),
          [200],
        ),
      ]);
      expect(metadataAfter.body).toStrictEqual(metadataBefore.body);
      expect(eventsResponse.body.events).toContainEqual(
        expect.objectContaining({
          id: reorderEventId,
          chatThreadId: firstThread.body.id,
          kind: "sort_touched",
          pinOrder: "Zy",
        }),
      );

      const replayedPinned = replayChatThreadEvents(
        [],
        eventsResponse.body.events,
      )
        .filter((thread) => {
          return thread.pinnedAt !== null;
        })
        .sort(comparePinnedThreads)
        .map((thread) => {
          return thread.id;
        });
      expect(replayedPinned).toStrictEqual([
        firstThread.body.id,
        secondThread.body.id,
      ]);
    },
  );
});
