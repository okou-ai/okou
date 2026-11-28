import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { isChatRunReference } from "@okouai/api-contracts/contracts/chat-run-reference";
import {
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import {
  webhookCompleteContract,
  webhookEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  type ChatRunFinishedEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { logsRoutes } from "../logs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);
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

const runApp = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...chatThreadRoutes,
    ...logsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentEventsRoutes,
  ],
});
const chatEventsApi = runApp(chatEventsContract);
const threadEventsApi = runApp(chatThreadEventsContract);
const logsListApi = runApp(logsListContract);
const runsCancelApi = runApp(runsCancelContract);
const webhookEventsApi = runApp(webhookEventsContract);
const webhookCompleteApi = runApp(webhookCompleteContract);

function signIn(user: ApiTestUser) {
  routeMocks.clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

async function grantProPlan(user: ApiTestUser): Promise<void> {
  const suffix = randomUUID();
  const customerId = `cus_pro_${suffix}`;
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
  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    await Promise.all([
      accept(
        threadsApi.create({
          headers: {},
          body: { title: "warmup" },
        }),
        [401],
      ),
      accept(
        workflowsApi.create({
          headers: {},
          body: { name: "warmup-wf", visibility: "private" },
        }),
        [401],
      ),
      accept(
        automationsApi.get({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: warmupId,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(
        threadEventsApi.rows({
          headers: {},
          params: { threadId: warmupId },
          query: { sinceSeqId: 0 },
        }),
        [401],
      ),
      accept(
        logsListApi.list({
          headers: {},
          query: { status: "running" },
        }),
        [401],
      ),
      accept(
        runsCancelApi.cancel({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        webhookEventsApi.send({
          headers: {},
          body: {
            runId: warmupId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 1,
                message: { content: [{ type: "text", text: "warmup" }] },
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        webhookCompleteApi.complete({
          headers: {},
          body: { runId: warmupId, exitCode: 0 },
        }),
        [401],
      ),
    ]);
  });

  it(
    "chat-run-finished-automations.bdd-011 reports no failure reason when a cancelled run triggers recovery",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const watchedTitle = "Watched cancelled run";
      const {
        actor,
        owner,
        watchedThreadId,
        watchedRunId,
        sandboxHeaders,
        automations,
      } = await setupWatchedRunScenario({
        watchedTitle,
        prompt: "Run that gets cancelled",
        model: null,
        withClaudeSubscription: false,
        rememberWatchedToken: false,
        automations: [
          { label: "recovery-cancelled", runStatuses: ["cancelled"] },
        ],
      });
      const recovery = automations[0];
      if (!recovery) {
        throw new Error("Expected recovery automation");
      }

      await accept(
        runsCancelApi.cancel({
          headers: signIn(actor),
          params: { id: watchedRunId },
        }),
        [200],
      );
      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            exitCode: 1,
            error: "Run cancelled",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [recoverySummary, recoveryEvents] = await Promise.all([
        readAutomation(actor, recovery.id),
        readThreadEvents(actor, recovery.chatThreadId),
      ]);

      expect(recoverySummary.lastRunAt).toStrictEqual(expect.any(String));
      const recoveryRunId = expectSingleLaunchedWatchedInput(recoveryEvents, {
        sourceRunId: watchedRunId,
        sourceThreadId: watchedThreadId,
        sourceTitle: watchedTitle,
      });
      const recoveryExecution = await owner.executionInput(recoveryRunId);
      expect(recoveryExecution.prompt).toContain('"runStatus": "cancelled"');
      expect(recoveryExecution.prompt).toContain('"failureReason": null');
    },
  );

  it(
    "chat-run-finished-automations.bdd-004 fires claimable matching automations when a watched run completes",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const watchedTitle = "Watched chat run";
      const {
        actor,
        owner,
        watchedThreadId,
        watchedRunId,
        sandboxHeaders,
        automations,
      } = await setupWatchedRunScenario({
        watchedTitle,
        prompt: "Run deployment check",
        model: "claude-fable-5-1",
        withClaudeSubscription: true,
        automations: [
          { label: "always" },
          { label: "failed-only", runStatuses: ["failed"] },
          {
            label: "pattern-match",
            runStatuses: ["completed"],
            outputPattern: "*deploy failed*",
          },
          {
            label: "pattern-miss",
            outputPattern: "*all systems nominal*",
          },
        ],
      });
      const [always, failedOnly, patternMatch, patternMiss] = automations;
      if (!always || !failedOnly || !patternMatch || !patternMiss) {
        throw new Error("Expected four watched automations");
      }

      const assistantText = "Alert: Deploy FAILED on prod";
      await accept(
        webhookEventsApi.send({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: watchedThreadId,
                sequenceNumber: 0,
              },
              {
                type: "assistant",
                sequenceNumber: 1,
                message: { content: [{ type: "text", text: assistantText }] },
              },
              { type: "result", sequenceNumber: 2, result: assistantText },
            ],
          },
        }),
        [200],
      );
      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            exitCode: 0,
            lastEventSequence: 2,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: watchedThreadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [
        alwaysSummary,
        failedOnlySummary,
        patternMatchSummary,
        patternMissSummary,
        alwaysEvents,
        runningLogs,
      ] = await Promise.all([
        readAutomation(actor, always.id),
        readAutomation(actor, failedOnly.id),
        readAutomation(actor, patternMatch.id),
        readAutomation(actor, patternMiss.id),
        readThreadEvents(actor, always.chatThreadId),
        accept(
          logsListApi.list({
            headers: signIn(actor),
            query: { status: "running" },
          }),
          [200],
        ),
      ]);

      expect(alwaysSummary.lastRunAt).toStrictEqual(expect.any(String));
      expect(patternMatchSummary.lastRunAt).toStrictEqual(expect.any(String));
      expect(failedOnlySummary.lastRunAt).toBeNull();
      expect(patternMissSummary.lastRunAt).toBeNull();

      const alwaysRunId = expectSingleLaunchedWatchedInput(alwaysEvents, {
        sourceRunId: watchedRunId,
        sourceThreadId: watchedThreadId,
        sourceTitle: watchedTitle,
        displayText: "A run in the watched chat thread completed.",
      });
      expect(runningLogs.body.data).toHaveLength(2);

      const triggeredExecution = await owner.executionInput(alwaysRunId);
      expect(triggeredExecution.prompt).toContain('"failureReason": null');
    },
  );

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

  interface WatchedAutomationSpec {
    readonly label: string;
    readonly runStatuses?: ChatRunFinishedEventConfig["runStatuses"];
    readonly outputPattern?: string;
  }

  async function readThreadEvents(
    actor: ApiTestUser,
    threadId: string,
  ): Promise<readonly ChatEvent[]> {
    const response = await accept(
      threadEventsApi.rows({
        headers: signIn(actor),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    return projectChatEventRows(response.body.rows);
  }

  async function setupWatchedRunScenario(args: {
    readonly watchedTitle: string;
    readonly prompt: string;
    readonly model?: string | null;
    readonly withClaudeSubscription: boolean;
    readonly automations: readonly WatchedAutomationSpec[];
    readonly rememberWatchedToken?: boolean;
  }) {
    const actor = bdd.user();
    chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    const runnerReady = runs.configureRunnerGroup({ maxConcurrent: 4 });
    const owner = publicRunOwner(context, actor);
    const authHeaders = signIn(actor);
    const [watchedThread, createdWorkflows] = await Promise.all([
      accept(
        threadsApi.create({
          headers: authHeaders,
          body: { title: args.watchedTitle },
        }),
        [201],
      ),
      Promise.all(
        args.automations.map((spec) => {
          return accept(
            workflowsApi.create({
              headers: authHeaders,
              body: {
                name: `${spec.label}-${randomUUID().slice(0, 8)}`,
                visibility: "private",
              },
            }),
            [201],
          );
        }),
      ),
      runnerReady,
      owner.run(() => {
        return runs.grantProEntitlement(actor);
      }),
      args.withClaudeSubscription
        ? owner.run(() => {
            return runs.ensurePersonalSubscriptionModel(actor);
          })
        : Promise.resolve(),
    ]);

    const watchedThreadId = watchedThread.body.id;

    const sendEventId = randomUUID();
    const [, ...createdAutomations] = await Promise.all([
      owner.run(() => {
        return accept(
          chatEventsApi.send({
            headers: signIn(actor),
            body: {
              threadId: watchedThreadId,
              prompt: args.prompt,
              hasTextContent: true,
              clientEventId: sendEventId,
              ...(args.model === undefined ? {} : { model: args.model }),
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: args.prompt }],
              },
            },
          }),
          [201],
        );
      }),
      ...args.automations.map((spec, index) => {
        const workflow = createdWorkflows[index];
        if (!workflow) {
          throw new Error("Expected created workflow for automation");
        }
        return accept(
          automationsApi.create({
            headers: signIn(actor),
            params: { workflowId: workflow.body.id },
            body: {
              kind: "event",
              eventType: "chat-run-finished",
              eventConfig: {
                provider: "chat",
                event: "run_finished",
                chatThreadId: watchedThreadId,
                ...(spec.runStatuses === undefined
                  ? {}
                  : { runStatuses: spec.runStatuses }),
                ...(spec.outputPattern === undefined
                  ? {}
                  : { outputPattern: spec.outputPattern }),
              },
            },
          }),
          [201],
        );
      }),
    ]);

    await flushWaitUntilForTest();
    const watchedEvents = await readThreadEvents(actor, watchedThreadId);
    const watchedRunId = watchedEvents.find((event) => {
      return event.revokesEventId === sendEventId;
    })?.runId;
    if (!watchedRunId) {
      throw new Error("Expected watched chat send to launch a Run");
    }

    const watchedExecution =
      args.rememberWatchedToken === false
        ? await runs.executionInput(watchedRunId)
        : await owner.executionInput(watchedRunId);
    const sandboxHeaders = {
      authorization: `Bearer ${watchedExecution.sandboxToken}`,
    };
    const automations = createdAutomations.map((created) => {
      const chatThreadId = created.body.chatThreadId;
      if (!chatThreadId) {
        throw new Error("Expected automation creation to bind a chat thread");
      }
      return { id: created.body.id, chatThreadId };
    });

    return {
      actor,
      owner,
      watchedThreadId,
      watchedRunId,
      sandboxHeaders,
      automations,
    };
  }

  async function readAutomation(actor: ApiTestUser, id: string) {
    const response = await accept(
      automationsApi.get({
        headers: signIn(actor),
        params: { id },
      }),
      [200],
    );
    return response.body;
  }

  function expectSingleLaunchedWatchedInput(
    events: readonly ChatEvent[],
    expected: {
      readonly sourceRunId: string;
      readonly sourceThreadId: string;
      readonly sourceTitle: string;
      readonly displayText?: string;
    },
  ): string {
    const launched = events.filter(
      (
        event,
      ): event is Extract<
        ChatEvent,
        { readonly eventType: "input.prompt" }
      > => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      },
    );
    expect(launched).toHaveLength(1);
    const input = launched[0];
    if (!input?.runId) {
      throw new Error("Expected launched automation input with runId");
    }
    const nonTextParts = input.userMessage.parts.filter((part) => {
      return part.type !== "text" && part.type !== "model";
    });
    expect(nonTextParts).toStrictEqual([
      {
        type: "chat_thread",
        runId: expected.sourceRunId,
        threadId: expected.sourceThreadId,
        titleSnapshot: expected.sourceTitle,
      },
    ]);
    expect(nonTextParts.every(isChatRunReference)).toBeTruthy();
    if (expected.displayText !== undefined) {
      expect(chatEventDisplayText(input)).toBe(expected.displayText);
    }
    return input.runId;
  }

  it(
    "chat-run-finished-automations.bdd-005 (1/2) fires failed-status automations and skips completed-status automations on errors",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const watchedTitle = "Watched failed run";
      const {
        actor,
        watchedThreadId,
        watchedRunId,
        sandboxHeaders,
        automations,
      } = await setupWatchedRunScenario({
        watchedTitle,
        prompt: "Trigger sandbox failure",
        model: "claude-fable-5-1",
        withClaudeSubscription: true,
        automations: [
          { label: "failed-only", runStatuses: ["failed"] },
          { label: "completed-only", runStatuses: ["completed"] },
        ],
      });
      const [failedOnly, completedOnly] = automations;
      if (!failedOnly || !completedOnly) {
        throw new Error("Expected two watched automations");
      }

      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            exitCode: 1,
            error: "boom: sandbox exploded",
            failureReason: "provider_rate_limited",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [failedOnlySummary, completedOnlySummary, failedOnlyEvents] =
        await Promise.all([
          readAutomation(actor, failedOnly.id),
          readAutomation(actor, completedOnly.id),
          readThreadEvents(actor, failedOnly.chatThreadId),
        ]);

      expect(failedOnlySummary.lastRunAt).toStrictEqual(expect.any(String));
      expect(completedOnlySummary.lastRunAt).toBeNull();

      expectSingleLaunchedWatchedInput(failedOnlyEvents, {
        sourceRunId: watchedRunId,
        sourceThreadId: watchedThreadId,
        sourceTitle: watchedTitle,
      });
    },
  );

  it(
    "chat-run-finished-automations.bdd-005 (2/2) skips pattern-filtered failed-status automations when the watched run fails without assistant output",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const watchedTitle = "Watched failed pattern run";
      const { actor, watchedRunId, sandboxHeaders, automations } =
        await setupWatchedRunScenario({
          watchedTitle,
          prompt: "Trigger sandbox failure without assistant text",
          model: "claude-fable-5-1",
          withClaudeSubscription: true,
          automations: [
            {
              label: "failed-boom",
              runStatuses: ["failed"],
              outputPattern: "*boom*",
            },
            {
              label: "failed-rate-limited",
              runStatuses: ["failed"],
              outputPattern: "*provider_rate_limited*",
            },
          ],
        });
      const [failedBoom, failedRateLimited] = automations;
      if (!failedBoom || !failedRateLimited) {
        throw new Error("Expected two pattern-filtered automations");
      }

      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            exitCode: 1,
            error: "boom: sandbox exploded",
            failureReason: "provider_rate_limited",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [failedBoomSummary, failedRateLimitedSummary] = await Promise.all([
        readAutomation(actor, failedBoom.id),
        readAutomation(actor, failedRateLimited.id),
      ]);

      expect(failedBoomSummary.lastRunAt).toBeNull();
      expect(failedRateLimitedSummary.lastRunAt).toBeNull();
    },
  );

  it(
    "chat-run-finished-automations.bdd-006 passes the recorded provider rate limit to the recovery Agent",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const watchedTitle = "Watched rate-limited run";
      const {
        actor,
        owner,
        watchedThreadId,
        watchedRunId,
        sandboxHeaders,
        automations,
      } = await setupWatchedRunScenario({
        watchedTitle,
        prompt: "Run that hits rate limit",
        model: "claude-fable-5-1",
        withClaudeSubscription: true,
        automations: [
          { label: "recovery-rate-limit", runStatuses: ["failed"] },
        ],
      });
      const recovery = automations[0];
      if (!recovery) {
        throw new Error("Expected recovery automation");
      }

      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            exitCode: 1,
            error: "The provider could not finish the request",
            failureReason: "provider_rate_limited",
          },
        }),
        [200],
      );
      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: watchedRunId,
            exitCode: 1,
            error: "The provider could not finish the request",
            failureReason: "provider_overloaded",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const [recoverySummary, sourceEvents, recoveryEvents] = await Promise.all(
        [
          readAutomation(actor, recovery.id),
          readThreadEvents(actor, watchedThreadId),
          readThreadEvents(actor, recovery.chatThreadId),
        ],
      );

      expect(recoverySummary.lastRunAt).toStrictEqual(expect.any(String));
      const failedEvent = sourceEvents.find((event) => {
        return event.eventType === "run.failed" && event.runId === watchedRunId;
      });
      expect(failedEvent).toMatchObject({
        eventType: "run.failed",
        failureReason: "provider_rate_limited",
      });

      const recoveryRunId = expectSingleLaunchedWatchedInput(recoveryEvents, {
        sourceRunId: watchedRunId,
        sourceThreadId: watchedThreadId,
        sourceTitle: watchedTitle,
      });
      const recoveryExecution = await owner.executionInput(recoveryRunId);
      expect(recoveryExecution.prompt).toContain('"runStatus": "failed"');
      expect(recoveryExecution.prompt).toContain(
        '"failureReason": "provider_rate_limited"',
      );
    },
  );
});
