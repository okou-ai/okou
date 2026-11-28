import { randomUUID } from "node:crypto";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { semanticChatEventsFromChatEvents } from "@okouai/api-contracts/contracts/chat-event-semantics";
import { isChatRunReference } from "@okouai/api-contracts/contracts/chat-run-reference";
import {
  chatThreadEventsContract,
  chatThreadRenameContract,
  chatThreadsContract,
  type ChatEvent,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { updateMaxAutonomyBudgetForTest$ } from "../../autonomy-budget-limit";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { authMeRoutes } from "../auth-me";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadRenameRoutes } from "../chat-threads-rename";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { chatEventDisplayText } from "./helpers/chat-event";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  okouTokenFromExecution,
  userMessages,
  type ChatRunCompletionOptions,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";

const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";

function clerkUserProfile(actor: ApiTestUser) {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "Shared",
    lastName: "Queue",
    imageUrl: null,
  };
}

function textUserMessage(text: string): UserMessageInputDocument {
  return {
    version: 1,
    parts: [{ type: "text", text }],
  };
}

function completionOptionsForExecution(
  execution: RunnerExecutionInput,
  target: { readonly runId: string; readonly threadId: string },
): ChatRunCompletionOptions {
  if (execution.cliAgentType === "pi") {
    return {
      cliAgentType: "pi",
      cliAgentSessionId: execution.piSessionId ?? target.threadId,
    };
  }
  const cliAgentType =
    execution.cliAgentType === "codex" ? "codex" : "claude-code";
  return {
    cliAgentType,
    cliAgentSessionId: `bdd-${cliAgentType}-${target.runId}`,
  };
}

function bearerHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function findChatRunSourcePart(event: ChatEvent) {
  if (event.eventType !== "input.prompt") {
    return undefined;
  }
  return event.userMessage.parts.find((part) => {
    return isChatRunReference(part);
  });
}

describe("CHAT-02: shared user message queue", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runsApi = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const routeMocks = createRouteMocks(context);

  const authMeClient = setupAppWithRoutes({
    context,
    routes: authMeRoutes,
  })(authContract);
  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadsClient = setupAppWithRoutes({
    context,
    routes: chatThreadCreateRoutes,
  })(chatThreadsContract);
  const chatThreadEventsClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);
  const chatThreadRenameClient = setupAppWithRoutes({
    context,
    routes: chatThreadRenameRoutes,
  })(chatThreadRenameContract);
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
  const webhookCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookClerkClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);

  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup_clerk");
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );

    const settled = await settleIncludingAbort(() => {
      return Promise.all([
        accept(authMeClient.me({ headers: {} }), [401]),
        accept(
          chatEventsClient.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              clientEventId: WARMUP_UUID,
              userMessage: textUserMessage("warmup"),
            },
          }),
          [401],
        ),
        accept(
          chatThreadsClient.create({
            headers: {},
            body: {},
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
          chatThreadRenameClient.rename({
            headers: {},
            params: { id: WARMUP_UUID },
            body: { title: "Warmup" },
          }),
          [401],
        ),
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
          webhookCompleteClient.complete({
            headers: {},
            body: { runId: WARMUP_UUID, exitCode: 0 },
          }),
          [401],
        ),
        accept(webhookClerkClient.post({ body: "{}" }), [401]),
      ]);
    });

    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!settled.ok) {
      throw settled.error;
    }
  });

  function installBaseChatMocks(): void {
    chatCallbacks.acceptChatObjectStorage();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    chatCallbacks.disableVapid();
  }

  function authHeaders(actor: ApiTestUser): { readonly authorization: string } {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
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
  }

  async function readEventRowsFast(
    actor: ApiTestUser,
    threadId: string,
    cursor?: { readonly sinceSeqId: number; readonly sinceEventId: string },
  ): Promise<{
    readonly rows: readonly ChatEventRow[];
    readonly events: readonly ChatEvent[];
    readonly cursor: {
      readonly lastSeqId: number;
      readonly lastEventId: string | null;
    };
  }> {
    const response = await accept(
      chatThreadEventsClient.rows({
        headers: authHeaders(actor),
        params: { threadId },
        query: cursor
          ? {
              sinceSeqId: cursor.sinceSeqId,
              sinceEventId: cursor.sinceEventId,
              limit: 50,
            }
          : { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    return {
      rows: response.body.rows,
      events: projectChatEventRows(response.body.rows),
      cursor: response.body.cursor,
    };
  }

  function createActorHarness(actor: ApiTestUser) {
    const activeRunIds = new Set<string>();
    const pendingRecalls: {
      readonly threadId: string;
      readonly eventId: string;
    }[] = [];
    let runnerGroup: string | undefined;
    let restoreRuntime: (() => void) | undefined;

    onTestFinished(async () => {
      if (activeRunIds.size === 0 && pendingRecalls.length === 0) {
        return;
      }
      const restoreBaseline = captureConnectorExternalState(context);
      restoreRuntime?.();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const result = await settleIncludingAbort(async () => {
        await flushWaitUntilForTest();
        const headers = authHeaders(actor);
        if (pendingRecalls.length > 0) {
          await Promise.all(
            pendingRecalls.map((item) => {
              return accept(
                chatEventsClient.send({
                  headers,
                  body: {
                    threadId: item.threadId,
                    revokesEventId: item.eventId,
                  },
                }),
                [201, 409],
              );
            }),
          );
        }
        const runIdsToCancel = new Set(activeRunIds);
        if (runnerGroup) {
          for (const dispatch of runsApi.unobservedDispatches(runnerGroup)) {
            runIdsToCancel.add(dispatch.executionContext.runId);
          }
        }
        if (runIdsToCancel.size > 0) {
          await Promise.all(
            [...runIdsToCancel].map(async (runId) => {
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
            }),
          );
        }
        await flushWaitUntilForTest();
      });
      restoreBaseline();
      if (!result.ok) {
        throw result.error;
      }
    });

    function requireRunnerGroup(): string {
      if (!runnerGroup) {
        throw new Error("Expected runner group to be configured");
      }
      return runnerGroup;
    }

    return {
      actor,
      captureRuntime(group: string) {
        runnerGroup = group;
        restoreRuntime = captureConnectorExternalState(context);
      },
      recallOnCleanup(threadId: string, eventId: string) {
        pendingRecalls.push({ threadId, eventId });
      },
      async createThread(title?: string): Promise<string> {
        const response = await accept(
          chatThreadsClient.create({
            headers: authHeaders(actor),
            body: {
              model: null,
              ...(title === undefined ? {} : { title }),
            },
          }),
          [201],
        );
        return response.body.id;
      },
      async renameThread(threadId: string, title: string): Promise<void> {
        await accept(
          chatThreadRenameClient.rename({
            headers: authHeaders(actor),
            params: { id: threadId },
            body: { title },
          }),
          [204],
        );
      },
      async sendPrompt(body: {
        readonly prompt: string;
        readonly threadId?: string;
        readonly userMessage?: UserMessageInputDocument;
        readonly clientEventId?: string;
        readonly sourceRunId?: string;
        readonly model?: string | null;
        readonly headers?: { readonly authorization: string };
      }): Promise<{
        readonly status: 201;
        readonly threadId: string;
        readonly clientEventId: string;
      }> {
        const clientEventId = body.clientEventId ?? randomUUID();
        const response = await accept(
          chatEventsClient.send({
            headers: body.headers ?? authHeaders(actor),
            body: {
              prompt: body.prompt,
              ...(body.threadId === undefined
                ? {}
                : { threadId: body.threadId }),
              ...(body.sourceRunId === undefined
                ? {}
                : { sourceRunId: body.sourceRunId }),
              ...(body.model === undefined ? {} : { model: body.model }),
              userMessage: body.userMessage ?? textUserMessage(body.prompt),
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
      },
      async sendAndLaunch(body: {
        readonly prompt: string;
        readonly threadId?: string;
        readonly userMessage?: UserMessageInputDocument;
        readonly clientEventId?: string;
        readonly sourceRunId?: string;
        readonly model?: string | null;
        readonly headers?: { readonly authorization: string };
      }): Promise<{
        readonly runId: string;
        readonly threadId: string;
        readonly clientEventId: string;
        readonly execution: RunnerExecutionInput;
        readonly sandboxHeaders: { readonly authorization: string };
      }> {
        const clientEventId = body.clientEventId ?? randomUUID();
        const response = await accept(
          chatEventsClient.send({
            headers: body.headers ?? authHeaders(actor),
            body: {
              prompt: body.prompt,
              ...(body.threadId === undefined
                ? {}
                : { threadId: body.threadId }),
              ...(body.sourceRunId === undefined
                ? {}
                : { sourceRunId: body.sourceRunId }),
              ...(body.model === undefined ? {} : { model: body.model }),
              userMessage: body.userMessage ?? textUserMessage(body.prompt),
              hasTextContent: true,
              clientEventId,
            },
          }),
          [201],
        );
        const execution =
          await runsApi.nextReceivedExecution(requireRunnerGroup());
        activeRunIds.add(execution.runId);
        return {
          runId: execution.runId,
          threadId: response.body.threadId,
          clientEventId,
          execution,
          sandboxHeaders: bearerHeaders(execution.sandboxToken),
        };
      },
      async nextExecution(): Promise<RunnerExecutionInput> {
        const execution =
          await runsApi.nextReceivedExecution(requireRunnerGroup());
        activeRunIds.add(execution.runId);
        return execution;
      },
      async runExecution(runId: string): Promise<RunnerExecutionInput> {
        const execution = await runsApi.executionInput(runId);
        activeRunIds.add(runId);
        return execution;
      },
      async completeRunOk(target: {
        readonly runId: string;
        readonly threadId: string;
        readonly execution: RunnerExecutionInput;
        readonly sandboxHeaders: { readonly authorization: string };
      }) {
        const completion = completionOptionsForExecution(
          target.execution,
          target,
        );
        await accept(
          webhookCompleteClient.complete({
            headers: target.sandboxHeaders,
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
        activeRunIds.delete(target.runId);
        await flushWaitUntilForTest();
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
      async deliverCancelledCompletion(
        runId: string,
        sandboxHeaders: { readonly authorization: string },
      ) {
        await accept(
          webhookCompleteClient.complete({
            headers: sandboxHeaders,
            body: { runId, exitCode: 1, error: "Run cancelled" },
          }),
          [200],
        );
        activeRunIds.delete(runId);
        await flushWaitUntilForTest();
      },
      recallEvent(threadId: string, revokesEventId: string) {
        return accept(
          chatEventsClient.send({
            headers: authHeaders(actor),
            body: { threadId, revokesEventId },
          }),
          [201],
        );
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
      readRows(
        threadId: string,
        cursor?: { readonly sinceSeqId: number; readonly sinceEventId: string },
      ) {
        return readEventRowsFast(actor, threadId, cursor);
      },
    };
  }

  async function createFreeActor(options?: {
    readonly concurrentRunLimitCap?: number;
    readonly maxAutonomyBudget?: number;
    readonly populateUserProfile?: boolean;
  }) {
    if (options?.concurrentRunLimitCap !== undefined) {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", options.concurrentRunLimitCap);
    }
    if (options?.maxAutonomyBudget !== undefined) {
      createStore().set(
        updateMaxAutonomyBudgetForTest$,
        options.maxAutonomyBudget,
      );
    }
    const actor = bdd.user();
    const harness = createActorHarness(actor);
    installBaseChatMocks();
    mockClerkUsers(context, [clerkUserProfile(actor)]);
    const [group] = await Promise.all([
      runsApi.configureRunnerGroup(),
      deliverOrgCreatedFast(actor),
      ...(options?.populateUserProfile
        ? [accept(authMeClient.me({ headers: authHeaders(actor) }), [200])]
        : []),
    ]);
    await flushWaitUntilForTest();
    harness.captureRuntime(group);
    return harness;
  }

  it(
    "chat-events-shared-queue-014 auto-fires queued messages after cancellation recovery completes",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor();

      const active = await envActor.sendAndLaunch({
        model: null,
        prompt: "Running anchor to be cancelled before queued promotion.",
      });

      const queuedPrompt =
        "Launch immediately once cancellation recovery ends.";
      const queued = await envActor.sendPrompt({
        threadId: active.threadId,
        model: null,
        prompt: queuedPrompt,
      });

      await envActor.cancelRun(active.runId);

      const [cancelledReadback, eventsBeforeCallback] = await Promise.all([
        envActor.readRun(active.runId),
        envActor.readRows(active.threadId),
      ]);
      expect(cancelledReadback.status).toBe("cancelled");
      expect(
        userMessages(eventsBeforeCallback.events).filter((event) => {
          return (
            event.revokesEventId === queued.clientEventId &&
            event.runId !== undefined
          );
        }),
      ).toStrictEqual([]);

      await envActor.deliverCancelledCompletion(
        active.runId,
        active.sandboxHeaders,
      );

      const [afterCallback, successorExec] = await Promise.all([
        envActor.readRows(active.threadId),
        envActor.nextExecution(),
      ]);
      const original = afterCallback.events.find((event) => {
        return event.id === queued.clientEventId;
      });
      const replacement = userMessages(afterCallback.events).find((event) => {
        return (
          event.revokesEventId === queued.clientEventId &&
          event.runId !== undefined
        );
      });
      if (!original || !replacement?.runId) {
        throw new Error(
          "Expected queued message to launch after cancellation callback",
        );
      }

      const replacementRow = afterCallback.rows.find((row) => {
        return row.id === replacement.id;
      });
      expect(replacement.runId).toBe(successorExec.runId);
      expect(original.runId).toBeUndefined();
      expect(replacement.revokesEventId).toBe(queued.clientEventId);
      expect(replacement.content).toBeNull();
      expect(replacementRow?.payload?.content).toBeUndefined();
      expect(chatEventDisplayText(replacement)).toBe(queuedPrompt);

      const successorRun = await envActor.readRun(replacement.runId);
      expect(successorRun.prompt).toBe(queuedPrompt);
      expect(successorExec.prompt).toContain(queuedPrompt);
    },
  );

  it(
    "chat-events-shared-queue-001 dispatches idle-thread sends by appending a run-associated replacement",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor();
      const referencedTitle = "Quarterly Launch Notes";
      const [referencedThreadId, targetThreadId] = await Promise.all([
        envActor.createThread(referencedTitle),
        envActor.createThread("Idle Target Thread"),
      ]);

      const clientEventId = randomUUID();
      const structuredMessage: UserMessageInputDocument = {
        version: 1,
        parts: [
          { type: "text", text: "Review " },
          {
            type: "chat_thread",
            threadId: referencedThreadId,
            titleSnapshot: referencedTitle,
          },
          { type: "text", text: " before drafting the release checklist." },
        ],
      };
      const promptText = `Review ${referencedTitle} before drafting the release checklist.`;

      const beforeSendMs = now();
      const firstSend = await envActor.sendPrompt({
        threadId: targetThreadId,
        model: null,
        prompt: promptText,
        userMessage: structuredMessage,
        clientEventId,
      });
      await flushWaitUntilForTest();
      const afterSendMs = now();

      const beforeRetry = await envActor.readRows(targetThreadId);
      const retrySend = await envActor.sendPrompt({
        threadId: targetThreadId,
        model: null,
        prompt: promptText,
        userMessage: structuredMessage,
        clientEventId,
      });
      const [afterRetry, execution] = await Promise.all([
        envActor.readRows(targetThreadId),
        envActor.nextExecution(),
      ]);

      expect(firstSend.status).toBe(201);
      expect(retrySend.status).toBe(201);
      expect(retrySend.threadId).toBe(targetThreadId);
      expect(afterRetry.rows).toHaveLength(beforeRetry.rows.length);

      const original = afterRetry.events.find((event) => {
        return event.id === clientEventId;
      });
      const replacements = userMessages(afterRetry.events).filter((event) => {
        return event.revokesEventId === clientEventId;
      });
      expect(original).toBeDefined();
      expect(original?.runId).toBeUndefined();
      expect(original?.eventType).toBe("input.prompt");
      if (original?.eventType === "input.prompt") {
        expect(original.userMessage.parts).toStrictEqual(
          structuredMessage.parts,
        );
      }

      expect(replacements).toHaveLength(1);
      const replacement = replacements[0];
      if (
        !original ||
        !replacement ||
        replacement.eventType !== "input.prompt" ||
        !replacement.runId
      ) {
        throw new Error(
          "Expected exactly one run-associated replacement prompt",
        );
      }
      expect(replacement.id).not.toBe(clientEventId);
      expect(replacement.seqId).toBeGreaterThan(original.seqId);
      expect(replacement.revokesEventId).toBe(clientEventId);
      expect(replacement.runId).toBe(execution.runId);
      expect(replacement.userMessage.parts).toContainEqual(
        expect.objectContaining({
          type: "model",
          selectedModel: expect.any(String),
        }),
      );

      expect(
        context.mocks.ably.publish.mock.calls.some(([topic]) => {
          return topic === `chatThreadMessageCreated:${targetThreadId}`;
        }),
      ).toBeTruthy();

      expect(execution.apiStartTime).toBeDefined();
      expect(Number.isInteger(execution.apiStartTime)).toBeTruthy();
      expect(execution.apiStartTime).toBeGreaterThanOrEqual(beforeSendMs);
      expect(execution.apiStartTime).toBeLessThanOrEqual(afterSendMs);
      expect(execution.prompt).toContain(
        `[${referencedTitle}](/chats/${referencedThreadId})`,
      );
      expect(execution.appendSystemPrompt ?? "").toContain(
        `CHAT_THREAD_ID=${referencedThreadId}`,
      );
    },
  );

  it(
    "chat-events-shared-queue-005 (1/2) preserves authentic source provenance on immediate delegation and rejects forged source references",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor();
      const sourceTitle = "Incident Triage Hub";
      const [sourceThreadId, delegatedThreadId, forgedThreadId] =
        await Promise.all([
          envActor.createThread(sourceTitle),
          envActor.createThread("Delegated Investigation"),
          envActor.createThread("Forged Target Thread"),
        ]);

      const sourceRun = await envActor.sendAndLaunch({
        threadId: sourceThreadId,
        model: null,
        prompt: "Coordinate downstream checks across target threads.",
      });
      const sourceOkouToken = okouTokenFromExecution(sourceRun.execution);

      expect(sourceRun.execution.appendSystemPrompt ?? "").not.toContain(
        "# This Run's Trigger",
      );

      const [delegatedRun, forgedResponse] = await Promise.all([
        envActor.sendAndLaunch({
          threadId: delegatedThreadId,
          model: null,
          headers: bearerHeaders(sourceOkouToken),
          prompt: "Investigate edge cache latency spike.",
        }),
        accept(
          chatEventsClient.send({
            headers: authHeaders(envActor.actor),
            body: {
              threadId: forgedThreadId,
              model: null,
              prompt: "Attempt forged handoff",
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: "Attempt forged handoff" },
                  {
                    type: "chat_thread",
                    threadId: sourceThreadId,
                    titleSnapshot: sourceTitle,
                    runId: sourceRun.runId,
                  },
                ],
              },
              hasTextContent: true,
              clientEventId: randomUUID(),
            },
          }),
          [400],
        ),
      ]);

      expect(forgedResponse.status).toBe(400);
      expect(forgedResponse.body.error.message).toBe(
        "Forwarded chat references are server-managed",
      );

      const [delegatedPage, forgedPage] = await Promise.all([
        envActor.readRows(delegatedThreadId),
        envActor.readRows(forgedThreadId),
      ]);
      expect(forgedPage.rows).toStrictEqual([]);

      const acceptedDelegation = delegatedPage.events.find((event) => {
        return event.id === delegatedRun.clientEventId;
      });
      expect(
        acceptedDelegation
          ? findChatRunSourcePart(acceptedDelegation)
          : undefined,
      ).toStrictEqual({
        type: "chat_thread",
        runId: sourceRun.runId,
        threadId: sourceThreadId,
        titleSnapshot: sourceTitle,
      });

      const targetGuidance = delegatedRun.execution.appendSystemPrompt ?? "";
      expect(targetGuidance).toContain("# This Run's Trigger");
      expect(targetGuidance).toContain(
        "sent by an agent run in another chat thread. A person did not type it here.",
      );
      expect(targetGuidance).toContain(`- SOURCE_RUN_ID: ${sourceRun.runId}`);
      expect(targetGuidance).toContain(`- SOURCE_THREAD_ID: ${sourceThreadId}`);
      expect(targetGuidance).toContain(`- SOURCE_THREAD_TITLE: ${sourceTitle}`);
      expect(targetGuidance).toContain(
        `okou chat messages --thread-id ${sourceThreadId} --output-dir /tmp/okou-chat-history`,
      );
      expect(targetGuidance).toContain(
        `okou chat get --thread-id ${sourceThreadId}`,
      );
      expect(targetGuidance).toContain(
        `okou search "${sourceRun.runId}" --source agent-session`,
      );
    },
  );

  it(
    "chat-events-shared-queue-005 (2/2) captures renamed source title across queued delegation and human forward and launches when capacity frees",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({ concurrentRunLimitCap: 2 });
      const initialTitle = "Launch Readiness v1";
      const renamedTitle = "Launch Readiness v2";
      const [
        sourceThreadId,
        immediateTargetId,
        queuedTargetId,
        forwardTargetId,
      ] = await Promise.all([
        envActor.createThread(initialTitle),
        envActor.createThread("Immediate Slot Consumer"),
        envActor.createThread("Queued Delegation Target"),
        envActor.createThread("Human Forward Target"),
      ]);

      const sourceRun = await envActor.sendAndLaunch({
        threadId: sourceThreadId,
        model: null,
        prompt: "Drive parallel work across release threads.",
      });
      const sourceOkouToken = okouTokenFromExecution(sourceRun.execution);

      const immediateRun = await envActor.sendAndLaunch({
        threadId: immediateTargetId,
        model: null,
        headers: bearerHeaders(sourceOkouToken),
        prompt: "Fill the second org concurrency slot immediately.",
      });

      await envActor.renameThread(sourceThreadId, renamedTitle);

      const queuedDelegation = await envActor.sendPrompt({
        threadId: queuedTargetId,
        model: null,
        headers: bearerHeaders(sourceOkouToken),
        prompt: "Run after workspace capacity opens up.",
      });
      const humanForward = await envActor.sendPrompt({
        threadId: forwardTargetId,
        model: null,
        sourceRunId: sourceRun.runId,
        prompt: "Human follow-up forwarded after source rename.",
      });
      envActor.recallOnCleanup(forwardTargetId, humanForward.clientEventId);
      await flushWaitUntilForTest();

      const [queuedPageBeforeFree, immediatePage, forwardPage] =
        await Promise.all([
          envActor.readRows(queuedTargetId),
          envActor.readRows(immediateTargetId),
          envActor.readRows(forwardTargetId),
        ]);
      expect(
        userMessages(queuedPageBeforeFree.events).filter((event) => {
          return (
            event.revokesEventId === queuedDelegation.clientEventId &&
            event.runId !== undefined
          );
        }),
      ).toStrictEqual([]);

      const immediateOriginal = immediatePage.events.find((event) => {
        return event.id === immediateRun.clientEventId;
      });
      const forwardOriginal = forwardPage.events.find((event) => {
        return event.id === humanForward.clientEventId;
      });
      expect(
        immediateOriginal
          ? findChatRunSourcePart(immediateOriginal)
          : undefined,
      ).toStrictEqual({
        type: "chat_thread",
        runId: sourceRun.runId,
        threadId: sourceThreadId,
        titleSnapshot: initialTitle,
      });
      expect(
        forwardOriginal ? findChatRunSourcePart(forwardOriginal) : undefined,
      ).toStrictEqual({
        type: "chat_thread",
        runId: sourceRun.runId,
        threadId: sourceThreadId,
        titleSnapshot: renamedTitle,
      });

      await envActor.completeRunOk(immediateRun);

      const [queuedPageAfterFree, queuedExec] = await Promise.all([
        envActor.readRows(queuedTargetId),
        envActor.nextExecution(),
      ]);
      const queuedOriginal = queuedPageAfterFree.events.find((event) => {
        return event.id === queuedDelegation.clientEventId;
      });
      const queuedClaimed = userMessages(queuedPageAfterFree.events).find(
        (event) => {
          return (
            event.revokesEventId === queuedDelegation.clientEventId &&
            event.runId !== undefined
          );
        },
      );
      if (!queuedOriginal || !queuedClaimed?.runId) {
        throw new Error(
          "Expected queued delegation to launch once a workspace slot freed",
        );
      }
      expect(queuedClaimed.runId).toBe(queuedExec.runId);
      expect(findChatRunSourcePart(queuedOriginal)).toStrictEqual({
        type: "chat_thread",
        runId: sourceRun.runId,
        threadId: sourceThreadId,
        titleSnapshot: renamedTitle,
      });

      const queuedGuidance = queuedExec.appendSystemPrompt ?? "";
      expect(queuedGuidance).toContain(`- SOURCE_RUN_ID: ${sourceRun.runId}`);
      expect(queuedGuidance).toContain(`- SOURCE_THREAD_ID: ${sourceThreadId}`);
      expect(queuedGuidance).toContain(
        `- SOURCE_THREAD_TITLE: ${renamedTitle}`,
      );
      expect(queuedGuidance).toContain(
        `okou chat messages --thread-id ${sourceThreadId} --output-dir /tmp/okou-chat-history`,
      );
    },
  );

  it(
    "chat-events-shared-queue-007 blocks cross-thread delegation from a zero-budget run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({
        concurrentRunLimitCap: 0,
        maxAutonomyBudget: 1,
      });
      const [delegatedThreadId, blockedThreadId] = await Promise.all([
        envActor.createThread("First Hop Thread"),
        envActor.createThread("Second Hop Blocked Thread"),
      ]);

      const rootRun = await envActor.sendAndLaunch({
        model: null,
        prompt: "Start a root run allowed exactly one delegation hop.",
      });
      const rootOkouToken = okouTokenFromExecution(rootRun.execution);

      const delegatedRun = await envActor.sendAndLaunch({
        threadId: delegatedThreadId,
        model: null,
        headers: bearerHeaders(rootOkouToken),
        prompt: "Consume the single allowed delegation hop.",
      });
      const delegatedOkouToken = okouTokenFromExecution(delegatedRun.execution);

      const blockedSend = await envActor.sendPrompt({
        threadId: blockedThreadId,
        model: null,
        headers: bearerHeaders(delegatedOkouToken),
        prompt: "Attempt a further cross-thread delegation at zero budget.",
      });
      expect(blockedSend.status).toBe(201);
      expect(blockedSend.threadId).toBe(blockedThreadId);

      await flushWaitUntilForTest();

      const blockedPage = await envActor.readRows(blockedThreadId);
      const rejectedEvents = blockedPage.events.filter((event) => {
        return event.eventType === "input.rejected";
      });
      const outputErrors = blockedPage.events.filter((event) => {
        return event.eventType === "output.error";
      });
      const launchedReplacements = userMessages(blockedPage.events).filter(
        (event) => {
          return event.runId !== undefined;
        },
      );

      expect(launchedReplacements).toStrictEqual([]);
      expect(rejectedEvents).toHaveLength(1);
      expect(rejectedEvents[0]).toMatchObject({
        eventType: "input.rejected",
        revokesEventId: blockedSend.clientEventId,
        error: "autonomy_budget_exhausted",
      });
      expect(outputErrors).toHaveLength(1);
      expect(outputErrors[0]).toMatchObject({
        eventType: "output.error",
        error: "autonomy_budget_exhausted",
      });
    },
  );

  it(
    "chat-events-shared-queue-010 appends a claimed queued message after messages that are still queued",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor();

      const active = await envActor.sendAndLaunch({
        model: null,
        prompt: "Hold the thread while two follow-up prompts wait in queue.",
      });

      const firstQueued = await envActor.sendPrompt({
        threadId: active.threadId,
        model: null,
        prompt: "First queued prompt to be claimed next.",
      });
      const secondQueued = await envActor.sendPrompt({
        threadId: active.threadId,
        model: null,
        prompt: "Second queued prompt that remains waiting.",
      });
      envActor.recallOnCleanup(active.threadId, secondQueued.clientEventId);

      await envActor.completeRunOk(active);

      const [page, firstExec] = await Promise.all([
        envActor.readRows(active.threadId),
        envActor.nextExecution(),
      ]);
      const firstOriginal = page.events.find((event) => {
        return event.id === firstQueued.clientEventId;
      });
      const secondOriginal = page.events.find((event) => {
        return event.id === secondQueued.clientEventId;
      });
      const firstClaimed = userMessages(page.events).find((event) => {
        return (
          event.revokesEventId === firstQueued.clientEventId &&
          event.runId !== undefined
        );
      });
      if (!firstOriginal || !secondOriginal || !firstClaimed?.runId) {
        throw new Error(
          "Expected originals and claimed replacement in thread events",
        );
      }

      expect(firstClaimed.runId).toBe(firstExec.runId);
      expect(firstOriginal.runId).toBeUndefined();
      expect(secondOriginal.runId).toBeUndefined();
      expect(firstOriginal.seqId).toBeLessThan(secondOriginal.seqId);
      expect(firstClaimed.seqId).toBeGreaterThan(secondOriginal.seqId);
      expect(
        userMessages(page.events).filter((event) => {
          return event.revokesEventId === secondQueued.clientEventId;
        }),
      ).toStrictEqual([]);

      const visibleUserPromptIds = semanticChatEventsFromChatEvents(page.events)
        .filter((entry) => {
          return entry.event.eventType === "input.prompt";
        })
        .map((entry) => {
          return entry.event.id;
        });

      expect(visibleUserPromptIds).not.toContain(firstOriginal.id);
      const secondIndex = visibleUserPromptIds.indexOf(secondOriginal.id);
      const firstClaimedIndex = visibleUserPromptIds.indexOf(firstClaimed.id);
      expect(secondIndex).toBeGreaterThan(-1);
      expect(firstClaimedIndex).toBeGreaterThan(secondIndex);
    },
  );

  it(
    "chat-events-shared-queue-012 appends replacements on auto-send and keeps queued recalls idempotent",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor();

      const active = await envActor.sendAndLaunch({
        model: null,
        prompt: "Active run holding two queued follow-up messages.",
      });

      const recalledPrompt = "Recalled prompt that must never launch.";
      const retainedPrompt = "Retained prompt that auto-sends next.";
      const [recalled, retained] = await Promise.all([
        envActor.sendPrompt({
          threadId: active.threadId,
          model: null,
          prompt: recalledPrompt,
        }),
        envActor.sendPrompt({
          threadId: active.threadId,
          model: null,
          prompt: retainedPrompt,
        }),
      ]);

      const firstRecall = await envActor.recallEvent(
        active.threadId,
        recalled.clientEventId,
      );
      const secondRecall = await envActor.recallEvent(
        active.threadId,
        recalled.clientEventId,
      );
      expect(firstRecall.status).toBe(201);
      expect(secondRecall.status).toBe(201);

      const beforeFinish = await envActor.readRows(active.threadId);
      const cursorEventId = beforeFinish.cursor.lastEventId;
      if (!cursorEventId || beforeFinish.cursor.lastSeqId <= 0) {
        throw new Error("Expected a valid paired cursor before completion");
      }

      const publishCountBeforeFinish =
        context.mocks.ably.publish.mock.calls.length;
      await envActor.completeRunOk(active);

      const [fullPage, pagedAfterFinish, promotedExec] = await Promise.all([
        envActor.readRows(active.threadId),
        envActor.readRows(active.threadId, {
          sinceSeqId: beforeFinish.cursor.lastSeqId,
          sinceEventId: cursorEventId,
        }),
        envActor.nextExecution(),
      ]);

      const controlRevokes = fullPage.events.filter((event) => {
        return (
          event.eventType === "control.revoke" &&
          event.revokesEventId === recalled.clientEventId
        );
      });
      expect(controlRevokes).toHaveLength(1);

      const recalledRunReplacements = userMessages(fullPage.events).filter(
        (event) => {
          return (
            event.revokesEventId === recalled.clientEventId &&
            event.runId !== undefined
          );
        },
      );
      expect(recalledRunReplacements).toStrictEqual([]);

      const retainedOriginal = fullPage.events.find((event) => {
        return event.id === retained.clientEventId;
      });
      const retainedReplacement = userMessages(fullPage.events).find(
        (event) => {
          return (
            event.revokesEventId === retained.clientEventId &&
            event.runId !== undefined
          );
        },
      );
      if (!retainedOriginal || !retainedReplacement?.runId) {
        throw new Error(
          "Expected retained prompt original and run-associated replacement",
        );
      }
      expect(retainedReplacement.runId).toBe(promotedExec.runId);
      expect(retainedOriginal.runId).toBeUndefined();
      expect(retainedReplacement.seqId).toBeGreaterThan(retainedOriginal.seqId);
      expect(retainedReplacement.revokesEventId).toBe(retained.clientEventId);
      expect(retainedReplacement.content).toBeNull();
      expect(chatEventDisplayText(retainedReplacement)).toBe(retainedPrompt);

      const pagedReplacementRow = pagedAfterFinish.rows.find((row) => {
        return row.id === retainedReplacement.id;
      });
      expect(pagedReplacementRow).toBeDefined();
      expect(pagedReplacementRow?.revokesEventId).toBe(retained.clientEventId);
      expect(pagedReplacementRow?.runId).toBe(retainedReplacement.runId);
      expect(pagedReplacementRow?.payload?.content).toBeUndefined();

      expect(
        context.mocks.ably.publish.mock.calls
          .slice(publishCountBeforeFinish)
          .some(([topic]) => {
            return topic === `chatThreadMessageCreated:${active.threadId}`;
          }),
      ).toBeTruthy();

      expect(promotedExec.prompt).toContain(retainedPrompt);
      expect(promotedExec.prompt).not.toContain(recalledPrompt);
      expect(promotedExec.appendSystemPrompt ?? "").not.toContain(
        recalledPrompt,
      );
    },
  );

  it(
    "chat-events-shared-queue-004 persists user-forwarded run provenance across chat threads",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envActor = await createFreeActor({
        maxAutonomyBudget: 0,
        populateUserProfile: true,
      });
      const sourceTitle = "Billing Cutover Review";
      const [sourceThreadId, targetThreadId] = await Promise.all([
        envActor.createThread(sourceTitle),
        envActor.createThread("Mitigation Plan Target"),
      ]);

      const sourceRun = await envActor.sendAndLaunch({
        threadId: sourceThreadId,
        model: null,
        prompt: "Identify billing cutover risks for launch.",
      });

      const forwardedQuote =
        "Freeze billing schema migrations during the launch window.";
      const forwardedNote =
        "Turn this constraint into a customer rollout note.";
      const forwardedMessage: UserMessageInputDocument = {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: forwardedQuote,
            note: [{ type: "text", text: forwardedNote }],
          },
        ],
      };

      const [forwardedRun, unknownSourceRes, unknownTargetRes] =
        await Promise.all([
          envActor.sendAndLaunch({
            threadId: targetThreadId,
            model: null,
            sourceRunId: sourceRun.runId,
            prompt: forwardedNote,
            userMessage: forwardedMessage,
          }),
          accept(
            chatEventsClient.send({
              headers: authHeaders(envActor.actor),
              body: {
                threadId: targetThreadId,
                model: null,
                sourceRunId: randomUUID(),
                prompt: "Forward from unknown run",
                userMessage: textUserMessage("Forward from unknown run"),
                hasTextContent: true,
                clientEventId: randomUUID(),
              },
            }),
            [400],
          ),
          accept(
            chatEventsClient.send({
              headers: authHeaders(envActor.actor),
              body: {
                threadId: randomUUID(),
                model: null,
                sourceRunId: sourceRun.runId,
                prompt: "Forward to unknown thread",
                userMessage: textUserMessage("Forward to unknown thread"),
                hasTextContent: true,
                clientEventId: randomUUID(),
              },
            }),
            [404],
          ),
        ]);

      expect(unknownSourceRes.status).toBe(400);
      expect(unknownSourceRes.body.error.message).toBe(
        "Forward source run not found",
      );
      expect(unknownTargetRes.status).toBe(404);
      expect(unknownTargetRes.body.error.message).toBe("Chat thread not found");

      const targetPage = await envActor.readRows(targetThreadId);
      const acceptedOriginal = targetPage.events.find((event) => {
        return event.id === forwardedRun.clientEventId;
      });
      expect(acceptedOriginal).toBeDefined();
      expect(
        acceptedOriginal ? findChatRunSourcePart(acceptedOriginal) : undefined,
      ).toStrictEqual({
        type: "chat_thread",
        runId: sourceRun.runId,
        threadId: sourceThreadId,
        titleSnapshot: sourceTitle,
      });

      const systemGuidance = forwardedRun.execution.appendSystemPrompt ?? "";
      expect(systemGuidance).toContain("# This Run's Trigger");
      expect(systemGuidance).toContain(
        "sent by a person who forwarded selected content from an agent run in another chat thread.",
      );
      expect(systemGuidance).toContain(`- SOURCE_RUN_ID: ${sourceRun.runId}`);
      expect(systemGuidance).toContain(`- SOURCE_THREAD_ID: ${sourceThreadId}`);
      expect(systemGuidance).toContain(`- SOURCE_THREAD_TITLE: ${sourceTitle}`);
      expect(systemGuidance.split("# Current User Info")).toHaveLength(2);
      expect(systemGuidance).toContain(`Email: ${envActor.actor.email}`);
      expect(forwardedRun.execution.prompt).toContain(
        `The user forwarded this from the chat "${sourceTitle}":`,
      );
      expect(forwardedRun.execution.prompt).toContain(forwardedQuote);
    },
  );
});
