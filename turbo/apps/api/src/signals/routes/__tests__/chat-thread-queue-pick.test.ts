import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  type ChatEvent,
  type ChatRunOptionsRequest,
  type CodexServiceTier,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/chat-threads";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
} from "@okouai/api-contracts/contracts/user-model-preference";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadModelSelectionRoutes } from "../chat-threads-model-selection";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runModelsRoutes } from "../run-models";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import type { ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  createChatEventsFixture,
  userMessages,
  type ChatRunCompletionOptions,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";

const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";

function completionOptionsForExecution(
  execution: RunnerExecutionInput,
  target: { readonly runId: string; readonly threadId: string },
  sessionIdOverride?: string,
): ChatRunCompletionOptions {
  if (execution.cliAgentType === "pi") {
    return {
      cliAgentType: "pi",
      cliAgentSessionId:
        sessionIdOverride ?? execution.piSessionId ?? target.threadId,
    };
  }
  const cliAgentType =
    execution.cliAgentType === "codex" ? "codex" : "claude-code";
  return {
    cliAgentType,
    cliAgentSessionId:
      sessionIdOverride ?? `bdd-${cliAgentType}-${target.runId}`,
  };
}

describe("chat-thread-queue-pick", () => {
  const context = testContext();
  const fixture = createChatEventsFixture(context);
  const runsApi = createRunsApi(context);

  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadEventsClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);
  const chatThreadMetaClient = setupAppWithRoutes({
    context,
    routes: chatThreadGetRoutes,
  })(chatThreadMetadataContract);
  const chatThreadModelClient = setupAppWithRoutes({
    context,
    routes: chatThreadModelSelectionRoutes,
  })(chatThreadModelSelectionContract);
  const userModelPrefClient = setupAppWithRoutes({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);
  const runModelsClient = setupAppWithRoutes({
    context,
    routes: runModelsRoutes,
  })(runModelsMainContract);
  const runsByIdClient = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runsCancelClient = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const runnersHeartbeatClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const runnersSteerClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersSteerContract);
  const webhookCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookClerkClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const webhookStripeClient = setupAppWithRoutes({
    context,
    routes: webhooksStripeRoutes,
  })(webhookStripeContract);
  const personalProvidersClient = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const billingStatusClient = setupAppWithRoutes({
    context,
    routes: billingStatusRoutes,
  })(billingStatusContract);
  const onboardingCompleteClient = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const workflowsClient = setupAppWithRoutes({
    context,
    routes: workflowsRoutes,
  })(workflowsCollectionContract);
  const workflowAutomationsClient = setupAppWithRoutes({
    context,
    routes: workflowAutomationsRoutes,
  })(workflowAutomationsContract);

  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup_clerk");
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_warmup_stripe");
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );

    const settled = await settleIncludingAbort(() => {
      return Promise.all([
        accept(
          chatEventsClient.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              clientEventId: WARMUP_UUID,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
            },
          }),
          [401],
        ),
        accept(
          chatThreadEventsClient.rows({
            headers: {},
            params: { threadId: WARMUP_UUID },
            query: { sinceSeqId: 0 },
          }),
          [401],
        ),
        accept(
          chatThreadMetaClient.get({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          chatThreadModelClient.update({
            headers: {},
            params: { id: WARMUP_UUID },
            body: { model: null },
          }),
          [401],
        ),
        accept(
          userModelPrefClient.update({
            headers: {},
            body: { selectedModel: null, serviceTier: null },
          }),
          [401],
        ),
        accept(runModelsClient.list({ headers: {} }), [401]),
        accept(
          runsByIdClient.getById({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          runsCancelClient.cancel({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatClient.heartbeat({
            headers: {},
            body: {
              runnerId: WARMUP_UUID,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 8,
              totalMemoryMb: 16_384,
              maxConcurrent: 1,
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
          runnersSteerClient.next({
            headers: {},
            params: { runId: WARMUP_UUID },
          }),
          [401],
        ),
        accept(
          webhookCompleteClient.complete({
            headers: {},
            body: { runId: WARMUP_UUID, exitCode: 0 },
          }),
          [401],
        ),
        accept(webhookClerkClient.post({ body: "{}" }), [401]),
        accept(webhookStripeClient.post({ body: "{}" }), [401]),
        accept(
          personalProvidersClient.upsert({
            headers: {},
            body: {
              type: "claude-code-oauth-token",
              secret: "warmup",
            },
          }),
          [401],
        ),
        accept(billingStatusClient.get({ headers: {} }), [401]),
        accept(
          onboardingCompleteClient.complete({
            headers: {},
            body: {},
          }),
          [401],
        ),
        accept(
          workflowsClient.create({
            headers: {},
            body: { name: "warmup-workflow", visibility: "public" },
          }),
          [401],
        ),
        accept(
          workflowAutomationsClient.create({
            headers: {},
            params: { workflowId: WARMUP_UUID },
            body: { kind: "event", eventType: "webhook-received" },
          }),
          [401],
        ),
        accept(
          workflowAutomationsClient.delete({
            headers: {},
            params: { id: WARMUP_UUID },
          }),
          [401],
        ),
      ]);
    });

    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
    if (!settled.ok) {
      throw settled.error;
    }
  });

  function installBaseChatMocks(): void {
    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
  }

  function authHeaders(actor: ApiTestUser): { readonly authorization: string } {
    fixture.routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  async function deliverOrgCreatedFast(actor: ApiTestUser): Promise<void> {
    if (!actor.orgId) {
      throw new Error("Expected a workspace creator");
    }
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
      type: "organization.created",
      data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
    });
    await accept(webhookClerkClient.post({ body: "{}" }), [200]);
    await flushWaitUntilForTest();
  }

  async function listEventsFast(
    actor: ApiTestUser,
    threadId: string,
  ): Promise<readonly ChatEvent[]> {
    const response = await accept(
      chatThreadEventsClient.rows({
        headers: authHeaders(actor),
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    return projectChatEventRows(response.body.rows);
  }

  async function sendPromptFast(
    actor: ApiTestUser,
    body: {
      readonly prompt: string;
      readonly threadId?: string;
      readonly model?: string | null;
      readonly runOptions?: ChatRunOptionsRequest;
      readonly clientEventId?: string;
    },
  ) {
    const clientEventId = body.clientEventId ?? randomUUID();
    const response = await accept(
      chatEventsClient.send({
        headers: authHeaders(actor),
        body: {
          prompt: body.prompt,
          ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
          ...(body.model === undefined ? {} : { model: body.model }),
          ...(body.runOptions === undefined
            ? {}
            : { runOptions: body.runOptions }),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: body.prompt }],
          },
          hasTextContent: true,
          clientEventId,
        },
      }),
      [201],
    );
    return {
      status: response.status,
      threadId: response.body.threadId,
      clientEventId,
    };
  }

  function createActorHarness(actor: ApiTestUser) {
    const trackedRuns = new Map<string, string | undefined>();
    const beforeRunCleanup: (() => Promise<void>)[] = [];
    let runnerGroup: string | undefined;
    let restoreRuntime: (() => void) | undefined;

    onTestFinished(async () => {
      if (trackedRuns.size === 0 && beforeRunCleanup.length === 0) {
        return;
      }
      const restoreBaseline = captureConnectorExternalState(context);
      restoreRuntime?.();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const result = await settleIncludingAbort(async () => {
        await flushWaitUntilForTest();
        for (const task of beforeRunCleanup) {
          await task();
        }
        const headers = authHeaders(actor);
        async function stopTrackedRun(
          runId: string,
          sandboxToken: string | undefined,
        ) {
          const read = await accept(
            runsByIdClient.getById({ headers, params: { id: runId } }),
            [200],
          );
          if (["queued", "pending", "running"].includes(read.body.status)) {
            await accept(
              runsCancelClient.cancel({ headers, params: { id: runId } }),
              [200],
            );
          }
          if (
            sandboxToken &&
            !["completed", "failed", "timeout"].includes(read.body.status)
          ) {
            await accept(
              webhookCompleteClient.complete({
                headers: { authorization: `Bearer ${sandboxToken}` },
                body: { runId, exitCode: 1, error: "Run cancelled" },
              }),
              [200],
            );
          }
        }
        for (const [runId, sandboxToken] of trackedRuns) {
          await stopTrackedRun(runId, sandboxToken);
        }
        await flushWaitUntilForTest();
        if (runnerGroup) {
          for (const dispatch of runsApi.unobservedDispatches(runnerGroup)) {
            const extraRunId = dispatch.executionContext.runId;
            await fixture.api.executionInput(extraRunId);
            await stopTrackedRun(
              extraRunId,
              dispatch.executionContext.sandboxToken,
            );
          }
          await flushWaitUntilForTest();
        }
      });
      restoreBaseline();
      if (!result.ok) {
        throw result.error;
      }
    });

    return {
      actor,
      captureRuntime(group: string) {
        runnerGroup = group;
        restoreRuntime = captureConnectorExternalState(context);
      },
      onBeforeRunCleanup(task: () => Promise<void>) {
        beforeRunCleanup.push(task);
      },
      async sendAndLaunch(body: {
        readonly prompt: string;
        readonly threadId?: string;
        readonly model?: string | null;
        readonly runOptions?: ChatRunOptionsRequest;
        readonly clientEventId?: string;
      }): Promise<{ readonly runId: string; readonly threadId: string }> {
        const sent = await sendPromptFast(actor, body);
        await flushWaitUntilForTest();
        const events = await listEventsFast(actor, sent.threadId);
        const runId = userMessages(events).find((message) => {
          return (
            message.revokesEventId === sent.clientEventId &&
            message.runId !== undefined
          );
        })?.runId;
        if (!runId) {
          throw new Error("Expected the chat send to launch a run");
        }
        trackedRuns.set(runId, undefined);
        return { runId, threadId: sent.threadId };
      },
      async sendWaiting(body: {
        readonly prompt: string;
        readonly threadId?: string;
        readonly model?: string | null;
        readonly runOptions?: ChatRunOptionsRequest;
        readonly clientEventId?: string;
      }): Promise<{
        readonly threadId: string;
        readonly clientEventId: string;
        readonly launchedRun: () => Promise<{
          readonly runId: string;
          readonly threadId: string;
        }>;
      }> {
        const sent = await sendPromptFast(actor, body);
        await flushWaitUntilForTest();
        const events = await listEventsFast(actor, sent.threadId);
        expect(
          userMessages(events).filter((message) => {
            return (
              message.revokesEventId === sent.clientEventId &&
              message.runId !== undefined
            );
          }),
        ).toStrictEqual([]);
        return {
          threadId: sent.threadId,
          clientEventId: sent.clientEventId,
          launchedRun: async () => {
            await flushWaitUntilForTest();
            const updated = await listEventsFast(actor, sent.threadId);
            const runId = userMessages(updated).find((message) => {
              return (
                message.revokesEventId === sent.clientEventId &&
                message.runId !== undefined
              );
            })?.runId;
            if (!runId) {
              throw new Error("Expected the waiting input to launch a run");
            }
            trackedRuns.set(runId, undefined);
            return { runId, threadId: sent.threadId };
          },
        };
      },
      async runExecution(runId: string) {
        const execution = await fixture.api.executionInput(runId);
        trackedRuns.set(runId, execution.sandboxToken);
        return {
          execution,
          sandboxHeaders: { authorization: `Bearer ${execution.sandboxToken}` },
        };
      },
      async completeRunOk(
        target: { readonly runId: string; readonly threadId: string },
        execution: {
          readonly execution: RunnerExecutionInput;
          readonly sandboxHeaders: { readonly authorization: string };
        },
        sessionIdOverride?: string,
      ) {
        const completion = completionOptionsForExecution(
          execution.execution,
          target,
          sessionIdOverride,
        );
        await accept(
          webhookCompleteClient.complete({
            headers: execution.sandboxHeaders,
            body: {
              runId: target.runId,
              exitCode: 0,
              completion: {
                cliAgentType: completion.cliAgentType ?? "claude-code",
                cliAgentSessionId:
                  completion.cliAgentSessionId ?? `bdd-cli-${target.runId}`,
                cliAgentSessionHistoryDisposition: "native_only",
              },
            },
          }),
          [200],
        );
        trackedRuns.delete(target.runId);
        await flushWaitUntilForTest();
      },
      async failRun(
        runId: string,
        sandboxHeaders: { readonly authorization: string },
        error: string,
      ) {
        await accept(
          webhookCompleteClient.complete({
            headers: sandboxHeaders,
            body: { runId, exitCode: 1, error },
          }),
          [200],
        );
        trackedRuns.delete(runId);
        await flushWaitUntilForTest();
      },
      readRun(runId: string) {
        return accept(
          runsByIdClient.getById({
            headers: authHeaders(actor),
            params: { id: runId },
          }),
          [200],
        ).then((response) => {
          return response.body;
        });
      },
      async cancelRun(runId: string) {
        const response = await accept(
          runsCancelClient.cancel({
            headers: authHeaders(actor),
            params: { id: runId },
          }),
          [200],
        );
        await flushWaitUntilForTest();
        return response;
      },
      listEvents(threadId: string) {
        return listEventsFast(actor, threadId);
      },
      sendPrompt(body: Parameters<typeof sendPromptFast>[1]) {
        return sendPromptFast(actor, body);
      },
      async recallEvent(threadId: string, revokesEventId: string) {
        const response = await accept(
          chatEventsClient.send({
            headers: authHeaders(actor),
            body: { threadId, revokesEventId },
          }),
          [201],
        );
        await flushWaitUntilForTest();
        return response;
      },
      updateThreadModel(
        threadId: string,
        model: string | null,
        options?: {
          readonly codexServiceTier?: CodexServiceTier | null;
          readonly reasoningEffort?: ReasoningEffort;
        },
      ) {
        return accept(
          chatThreadModelClient.update({
            headers: authHeaders(actor),
            params: { id: threadId },
            body: {
              model,
              ...(options?.codexServiceTier === undefined
                ? {}
                : { codexServiceTier: options.codexServiceTier }),
              ...(options?.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: options.reasoningEffort }),
            },
          }),
          [204],
        );
      },
      updateAccountModel(body: UpdateUserModelPreferenceRequest) {
        return accept(
          userModelPrefClient.update({
            headers: authHeaders(actor),
            body,
          }),
          [200],
        );
      },
      readThreadMetadata(threadId: string) {
        return accept(
          chatThreadMetaClient.get({
            headers: authHeaders(actor),
            params: { id: threadId },
          }),
          [200],
        ).then((response) => {
          return response.body;
        });
      },
      nextSteerableInput(sandboxToken: string, runId: string) {
        return accept(
          runnersSteerClient.next({
            headers: { authorization: `Bearer ${sandboxToken}` },
            params: { runId },
          }),
          [200],
        ).then((response) => {
          return response.body;
        });
      },
      trackRun(runId: string) {
        if (!trackedRuns.has(runId)) {
          trackedRuns.set(runId, undefined);
        }
      },
    };
  }

  async function createFreeActor(options?: {
    readonly singleSlot?: boolean;
    readonly includeClaude?: boolean;
    readonly includeCodex?: boolean;
  }) {
    if (options?.singleSlot) {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
    }
    const actor = fixture.bdd.user();
    const harness = createActorHarness(actor);
    installBaseChatMocks();
    if (options?.includeClaude) {
      mockClaudeCodeTokenEndpoint();
    }
    const [group] = await Promise.all([
      fixture.api.configureRunnerGroup(),
      deliverOrgCreatedFast(actor),
      ...(options?.includeClaude
        ? [
            accept(
              personalProvidersClient.upsert({
                headers: authHeaders(actor),
                body: {
                  type: "claude-code-oauth-token",
                  secret: "bdd-personal-claude-token",
                },
              }),
              [200, 201],
            ),
          ]
        : []),
      ...(options?.includeCodex
        ? [fixture.connectSubscriptionPiModel(actor)]
        : []),
    ]);
    harness.captureRuntime(group);
    return harness;
  }

  it(
    "chat-thread-queue-pick-005 takes over input sent while the thread's run was running",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor();

      const active = await envActor.sendAndLaunch({
        model: null,
        prompt: "Initial active run on the thread",
      });
      const activeExec = await envActor.runExecution(active.runId);

      const followUpClientEventId = randomUUID();
      const followUpPrompt = "Unsteered follow-up sent during the running run";
      const followUpSend = await envActor.sendPrompt({
        threadId: active.threadId,
        model: null,
        prompt: followUpPrompt,
        clientEventId: followUpClientEventId,
      });
      await flushWaitUntilForTest();
      expect(followUpSend.status).toBe(201);

      const beforeComplete = await envActor.listEvents(active.threadId);
      expect(
        userMessages(beforeComplete).filter((message) => {
          return (
            message.revokesEventId === followUpClientEventId &&
            message.runId !== undefined
          );
        }),
      ).toStrictEqual([]);

      await envActor.completeRunOk(active, activeExec);

      const afterComplete = await envActor.listEvents(active.threadId);
      const successor = userMessages(afterComplete).find((message) => {
        return (
          message.revokesEventId === followUpClientEventId &&
          message.runId !== undefined
        );
      });
      const successorRunId = successor?.runId;
      expect(successorRunId).toBeDefined();
      expect(successorRunId).not.toBe(active.runId);
      if (!successorRunId) {
        throw new Error("Expected unsteered input to launch a successor run");
      }
      envActor.trackRun(successorRunId);

      const successorExec = await envActor.runExecution(successorRunId);
      expect(successorExec.execution.prompt).toBe(followUpPrompt);
    },
  );

  it(
    "chat-thread-queue-pick-003 gives the slot of a cancelled running run to a waiting thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({ singleSlot: true });

      const blocker = await envActor.sendAndLaunch({
        model: null,
        prompt: "Hold the sole workspace slot until cancelled and ended",
      });
      const blockerExec = await envActor.runExecution(blocker.runId);
      const startedRun = await envActor.readRun(blocker.runId);
      expect(startedRun.status).toBe("running");

      const waitingPrompt = "Launch after the cancelled blocker ends";
      const waiting = await envActor.sendWaiting({
        model: null,
        prompt: waitingPrompt,
      });

      const cancelResponse = await envActor.cancelRun(blocker.runId);
      expect(cancelResponse.status).toBe(200);

      const [cancelledReadback, stillWaiting] = await Promise.all([
        envActor.readRun(blocker.runId),
        envActor.listEvents(waiting.threadId),
      ]);
      expect(cancelledReadback.status).toBe("cancelled");
      expect(
        userMessages(stillWaiting).filter((message) => {
          return message.runId !== undefined;
        }),
      ).toStrictEqual([]);

      await envActor.failRun(
        blocker.runId,
        blockerExec.sandboxHeaders,
        "Run cancelled",
      );

      const launched = await waiting.launchedRun();
      const launchedExec = await envActor.runExecution(launched.runId);
      expect(launched.threadId).toBe(waiting.threadId);
      expect(launched.runId).not.toBe(blocker.runId);
      expect(launchedExec.execution.prompt).toBe(waitingPrompt);
    },
  );

  it(
    "chat-thread-queue-pick-001 launches only the FIFO head of a waiting thread and resumes its latest session",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({
        singleSlot: true,
        includeClaude: true,
      });

      const seedSessionId = `native-session-seed-${randomUUID().slice(0, 8)}`;
      const seed = await envActor.sendAndLaunch({
        model: "claude-fable-5-1",
        prompt: "Establish the target thread native session",
      });
      const seedExec = await envActor.runExecution(seed.runId);
      await envActor.completeRunOk(seed, seedExec, seedSessionId);

      const blocker = await envActor.sendAndLaunch({
        model: null,
        prompt: "Occupy the sole slot on an unrelated thread",
      });
      const blockerExec = await envActor.runExecution(blocker.runId);

      const firstClientEventId = randomUUID();
      const secondClientEventId = randomUUID();
      const firstPrompt = "First queued prompt resuming seed session";
      const secondPrompt = "Second queued prompt resuming head session";
      await envActor.sendPrompt({
        threadId: seed.threadId,
        model: "claude-fable-5-1",
        prompt: firstPrompt,
        clientEventId: firstClientEventId,
      });
      await envActor.sendPrompt({
        threadId: seed.threadId,
        model: "claude-fable-5-1",
        prompt: secondPrompt,
        clientEventId: secondClientEventId,
      });
      await flushWaitUntilForTest();

      await envActor.completeRunOk(blocker, blockerExec);

      const afterBlocker = await envActor.listEvents(seed.threadId);
      const headReplacement = userMessages(afterBlocker).find((message) => {
        return (
          message.revokesEventId === firstClientEventId &&
          message.runId !== undefined
        );
      });
      const secondBeforeHeadEnds = userMessages(afterBlocker).filter(
        (message) => {
          return (
            message.revokesEventId === secondClientEventId &&
            message.runId !== undefined
          );
        },
      );
      expect(headReplacement?.runId).toBeDefined();
      expect(secondBeforeHeadEnds).toStrictEqual([]);

      const headRunId = headReplacement?.runId;
      if (!headRunId) {
        throw new Error("Expected FIFO head prompt to launch a run");
      }
      envActor.trackRun(headRunId);
      const headExec = await envActor.runExecution(headRunId);
      expect(headExec.execution.prompt).toBe(firstPrompt);
      expect(headExec.execution.nativeContinuation).toMatchObject({
        sessionId: seedSessionId,
        generationRunId: seed.runId,
      });

      const headSessionId = `native-session-head-${randomUUID().slice(0, 8)}`;
      await envActor.completeRunOk(
        { runId: headRunId, threadId: seed.threadId },
        headExec,
        headSessionId,
      );

      const afterHead = await envActor.listEvents(seed.threadId);
      const secondReplacement = userMessages(afterHead).find((message) => {
        return (
          message.revokesEventId === secondClientEventId &&
          message.runId !== undefined
        );
      });
      const secondRunId = secondReplacement?.runId;
      expect(secondRunId).toBeDefined();
      expect(secondRunId).not.toBe(headRunId);
      expect(secondRunId).not.toBe(seed.runId);
      if (!secondRunId) {
        throw new Error("Expected second queued prompt to launch a run");
      }
      envActor.trackRun(secondRunId);

      const secondExec = await envActor.runExecution(secondRunId);
      expect(secondExec.execution.prompt).toBe(secondPrompt);
      expect(secondExec.execution.nativeContinuation).toMatchObject({
        sessionId: headSessionId,
        generationRunId: headRunId,
      });
    },
  );

  it(
    "chat-thread-queue-pick-007 leaves a queued automation event for the pick while steering later prompts",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = fixture.bdd.user();
      const envActor = createActorHarness(actor);
      fixture.bdd.acceptStorageWrites();
      installBaseChatMocks();
      const [group] = await Promise.all([
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor, { tier: "team" }),
      ]);
      envActor.captureRuntime(group);

      const createdWorkflow = await accept(
        workflowsClient.create({
          headers: authHeaders(actor),
          body: {
            name: `queue-pick-webhook-${randomUUID().slice(0, 8)}`,
            visibility: "public",
            instruction: "Process incoming webhook events.",
          },
        }),
        [201],
      );
      const createdAutomation = await accept(
        workflowAutomationsClient.create({
          headers: authHeaders(actor),
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
        throw new Error("Expected a signed webhook automation with a thread");
      }
      const automationThreadId = automation.chatThreadId;

      const activeRun = await envActor.sendAndLaunch({
        threadId: automationThreadId,
        model: null,
        prompt: "Occupy the signed webhook automation thread",
      });
      const activeExec = await envActor.runExecution(activeRun.runId);

      const delivered = await fixture.postThreadPiAutomationEvent({
        webhookUrl: automation.webhookUrl,
        webhookSecret: automation.webhookSecret,
        payload: "Queued signed automation event",
        timestamp: Math.floor(now() / 1000),
      });
      expect(delivered).toStrictEqual({ success: true, duplicate: false });

      const laterClientEventId = randomUUID();
      const laterPrompt = "Steer this user prompt past the queued automation";
      const laterSend = await envActor.sendPrompt({
        threadId: automationThreadId,
        model: null,
        prompt: laterPrompt,
        clientEventId: laterClientEventId,
      });
      await flushWaitUntilForTest();
      expect(laterSend.status).toBe(201);

      envActor.onBeforeRunCleanup(async () => {
        await Promise.all([
          envActor.recallEvent(automationThreadId, laterClientEventId),
          accept(
            workflowAutomationsClient.delete({
              headers: authHeaders(actor),
              params: { id: automation.id },
            }),
            [204],
          ),
        ]);
      });

      const [steerable, feed] = await Promise.all([
        envActor.nextSteerableInput(
          activeExec.execution.sandboxToken,
          activeRun.runId,
        ),
        envActor.listEvents(automationThreadId),
      ]);
      expect(steerable.input).toStrictEqual({
        eventId: laterClientEventId,
        prompt: laterPrompt,
      });

      const queuedAutomations = feed.filter((event) => {
        return event.eventType === "input.automation";
      });
      expect(queuedAutomations).toHaveLength(1);
      expect(queuedAutomations[0]?.runId).toBeUndefined();
    },
  );

  it(
    "chat-thread-queue-pick-009 keeps the queued model, service tier, and effort after thread and user settings change",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({
        singleSlot: true,
        includeClaude: true,
        includeCodex: true,
      });

      const blocker = await envActor.sendAndLaunch({
        model: "claude-fable-5-1",
        prompt: "Hold the single workspace slot while settings change",
      });
      const blockerExec = await envActor.runExecution(blocker.runId);

      const queuedPrompt = "Dispatch Astra with fast tier and low effort";
      const waiting = await envActor.sendWaiting({
        model: "gpt-6-astra",
        runOptions: {
          codexServiceTier: "fast",
          reasoningEffort: "low",
        },
        prompt: queuedPrompt,
      });

      await Promise.all([
        (async () => {
          await envActor.updateThreadModel(waiting.threadId, "gpt-6-astra", {
            codexServiceTier: null,
            reasoningEffort: "ultra",
          });
          await envActor.updateThreadModel(
            waiting.threadId,
            "claude-fable-5-1",
            {
              codexServiceTier: null,
            },
          );
        })(),
        (async () => {
          await envActor.updateAccountModel({
            selectedModel: "gpt-6-astra",
            serviceTier: null,
            modelSettingsPatch: { model: "gpt-6-astra", effort: "ultra" },
          });
          await envActor.updateAccountModel({
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
          });
        })(),
      ]);

      await envActor.completeRunOk(blocker, blockerExec);

      const launched = await waiting.launchedRun();
      const [launchedExec, threadMetadata] = await Promise.all([
        envActor.runExecution(launched.runId),
        envActor.readThreadMetadata(waiting.threadId),
      ]);

      expect(launched.threadId).toBe(waiting.threadId);
      expect(launchedExec.execution.prompt).toBe(queuedPrompt);
      expect(launchedExec.execution.modelUsageProvider).toBe("gpt-6-astra");
      expect(launchedExec.execution.platformEnvironment).toMatchObject({
        OKOU_CODEX_SERVICE_TIER: "fast",
        OKOU_REASONING_EFFORT: "low",
      });
      expect(threadMetadata).toMatchObject({
        selectedModel: "claude-fable-5-1",
        serviceTier: null,
        modelSettings: {
          "gpt-6-astra": { effort: "ultra" },
        },
      });
    },
  );

  it(
    "chat-thread-queue-pick-010 skips a recalled head and launches a later message on the thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({ singleSlot: true });

      const blocker = await envActor.sendAndLaunch({
        model: null,
        prompt: "Occupy the workspace slot while waiting input is recalled",
      });
      const blockerExec = await envActor.runExecution(blocker.runId);

      const recalledClientEventId = randomUUID();
      const waiting = await envActor.sendWaiting({
        model: null,
        prompt: "Queued prompt that will be recalled",
        clientEventId: recalledClientEventId,
      });

      const recallResponse = await envActor.recallEvent(
        waiting.threadId,
        recalledClientEventId,
      );
      expect(recallResponse.status).toBe(201);

      await envActor.completeRunOk(blocker, blockerExec);

      const afterBlocker = await envActor.listEvents(waiting.threadId);
      expect(
        afterBlocker.filter((event) => {
          return event.runId !== undefined;
        }),
      ).toStrictEqual([]);

      const laterPrompt = "Later prompt after the recalled head";
      const laterRun = await envActor.sendAndLaunch({
        threadId: waiting.threadId,
        model: null,
        prompt: laterPrompt,
      });
      const [laterExec, finalFeed] = await Promise.all([
        envActor.runExecution(laterRun.runId),
        envActor.listEvents(waiting.threadId),
      ]);
      const threadRunIds = [
        ...new Set(
          finalFeed.flatMap((event) => {
            return event.runId === undefined ? [] : [event.runId];
          }),
        ),
      ];

      expect(threadRunIds).toStrictEqual([laterRun.runId]);
      expect(laterExec.execution.prompt).toBe(laterPrompt);
    },
  );
});
