import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookCompleteContract,
  webhookEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { createBddApi } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
  createChatEventsFixture,
  eventBackedContents,
  userMessages,
} from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";

const CHAT_RECOVERY_COMMAND_SNIPPET =
  "okou chat messages --output-dir /tmp/okou-chat-history";

const context = testContext();
const bdd = createBddApi(context);
const sharedFixture = createChatEventsFixture(context);
const summaryClient = setupAppWithRoutes({
  context,
  routes: chatThreadActivitySummaryRoutes,
})(chatThreadActivitySummaryContract);
const warmupApp = setupApp({
  context,
  routes: [
    ...billingStatusRoutes,
    ...chatEventsRoutes,
    ...chatThreadRoutes,
    ...codexDeviceAuthRoutes,
    ...meModelProvidersUpsertRoutes,
    ...onboardingCompleteRoutes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentEventsRoutes,
  ],
});
const warmupBillingStatusApi = warmupApp(billingStatusContract);
const warmupChatEventsApi = warmupApp(chatEventsContract);
const warmupThreadEventsApi = warmupApp(chatThreadEventsContract);
const warmupCodexDeviceAuthApi = warmupApp(codexDeviceAuthContract);
const warmupModelProvidersApi = warmupApp(personalModelProvidersMainContract);
const warmupOnboardingApi = warmupApp(onboardingCompleteContract);
const warmupRunnersHeartbeatApi = warmupApp(runnersHeartbeatContract);
const warmupRunnersSteerApi = warmupApp(runnersSteerContract);
const warmupRunsByIdApi = warmupApp(runsByIdContract);
const warmupRunsCancelApi = warmupApp(runsCancelContract);
const warmupWebhookEventsApi = warmupApp(webhookEventsContract);
const warmupWebhookCompleteApi = warmupApp(webhookCompleteContract);

// File-level route & schema warm-up (unauthenticated 401s: zero DB access, zero side effects).
beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const warmupId = randomUUID();
  await Promise.all([
    accept(
      warmupChatEventsApi.send({
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
      warmupThreadEventsApi.rows({
        headers: {},
        params: { threadId: warmupId },
        query: { sinceSeqId: 0, limit: 1 },
      }),
      [401],
    ),
    accept(
      warmupCodexDeviceAuthApi.start({
        headers: {},
        body: { scope: "personal" },
      }),
      [401],
    ),
    accept(
      warmupCodexDeviceAuthApi.complete({
        headers: {},
        body: { sessionToken: "warmup" },
      }),
      [401],
    ),
    accept(
      warmupModelProvidersApi.upsert({
        headers: {},
        body: { type: "claude-code-oauth-token", secret: "warmup" },
      }),
      [401],
    ),
    accept(warmupOnboardingApi.complete({ headers: {}, body: {} }), [401]),
    accept(
      summaryClient.summarize({
        headers: {},
        params: { id: warmupId },
        body: { runId: warmupId },
      }),
      [401],
    ),
    accept(
      warmupRunnersSteerApi.next({
        headers: {},
        params: { runId: warmupId },
      }),
      [401],
    ),
    accept(
      warmupRunsByIdApi.getById({
        headers: {},
        params: { id: warmupId },
      }),
      [401],
    ),
    accept(
      warmupRunsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
      [401],
    ),
    accept(
      warmupWebhookEventsApi.send({
        headers: { authorization: "Bearer invalid-warmup-token" },
        body: {
          runId: warmupId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: warmupId,
              sequenceNumber: 1,
            },
          ],
        },
      }),
      [401],
    ),
    accept(
      warmupWebhookCompleteApi.complete({
        headers: { authorization: "Bearer invalid-warmup-token" },
        body: { runId: warmupId, exitCode: 0 },
      }),
      [401],
    ),
    accept(warmupBillingStatusApi.get({ headers: {} }), [401]),
    accept(
      warmupRunnersHeartbeatApi.heartbeat({
        headers: {},
        body: {
          runnerId: warmupId,
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
  ]);
});

async function createPiCodexChatActor(
  ctx: TestContext,
  options: { readonly includePersonalClaude?: boolean } = {},
) {
  const fixture = sharedFixture;
  const actor = fixture.bdd.user();
  let accepted = captureConnectorExternalState(ctx);
  let previous: (() => void) | undefined;
  onTestFinished(() => {
    previous?.();
  });
  const owner = publicRunOwner(ctx, actor, {
    continueAcceptedOperations: true,
    restoreEnvironment: () => {
      previous ??= captureConnectorExternalState(ctx);
      accepted();
    },
  });
  function run<T>(operation: () => Promise<T>) {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(ctx);
      return pending.then((result) => {
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      });
    });
  }
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();
  if (options.includePersonalClaude) {
    mockClaudeCodeTokenEndpoint();
  }
  await run(() => {
    return Promise.all([
      fixture.api.configureRunnerGroup(),
      bdd.bootstrapLimitedFreeOnboarding(actor),
      fixture.connectSubscriptionPiModel(actor),
      ...(options.includePersonalClaude
        ? [
            fixture.api.createPersonalModelProvider(actor, {
              type: "claude-code-oauth-token",
              secret: `claude-token-${randomUUID()}`,
            }),
          ]
        : []),
    ]);
  });
  return {
    actor,
    fixture,
    run,
    sendChatRun: (...parameters: Parameters<typeof fixture.sendChatRun>) => {
      return run(() => {
        return fixture.sendChatRun(...parameters);
      });
    },
    runExecution: (...parameters: Parameters<typeof fixture.runExecution>) => {
      return run(async () => {
        const execution = await fixture.runExecution(...parameters);
        owner.rememberExecution(
          parameters[0],
          execution.execution.sandboxToken,
        );
        return execution;
      });
    },
  };
}

describe("chat-events-pi-activity", () => {
  it(
    "chat-events-pi-activity-001 (3/5) clears resumable Pi generation after uninitialized failure and cancellation while keeping recovery guidance and prompts",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;

      const failedPrompt = "First prompt that fails before Pi init";
      const run1 = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: failedPrompt,
      });
      const exec1 = await chatActor.runExecution(run1.runId);
      await chatActor.run(() => {
        return fixture.webhooks.requestAgentComplete(
          {
            runId: run1.runId,
            exitCode: 1,
            error: "Sandbox failed before Pi init",
            failureReason: "provider_server_error",
          },
          exec1.sandboxHeaders,
          [200],
        );
      });
      await fixture.waitForRunStatus(actor, run1.runId, "failed");

      const cancelledPrompt = "Second prompt cancelled before Pi init";
      const run2 = await chatActor.sendChatRun(actor, {
        threadId: run1.threadId,
        model: "gpt-6-luna",
        prompt: cancelledPrompt,
      });
      const exec2 = await chatActor.runExecution(run2.runId);
      await chatActor.run(() => {
        return fixture.cancelChatRun(actor, run2.runId, exec2.sandboxHeaders);
      });

      const recoveryPrompt = "Third prompt after uninitialized turns";
      const run3 = await chatActor.sendChatRun(actor, {
        threadId: run1.threadId,
        model: "gpt-6-luna",
        prompt: recoveryPrompt,
      });
      const exec3 = await chatActor.runExecution(run3.runId);

      expect(exec3.execution.cliAgentType).toBe("pi");
      expect(exec3.execution.piSessionId).toBe(run1.threadId);
      expect(exec3.execution.nativeContinuation.sessionId).toBeNull();
      expect(exec3.execution.nativeContinuation.generationRunId).toBeNull();
      expect(exec3.execution.nativeContinuation.recoveryPrompt).toContain(
        CHAT_RECOVERY_COMMAND_SNIPPET,
      );

      const history = await fixture.chat.listThreadEvents(actor, run1.threadId);
      const promptTexts = userMessages(history.events)
        .filter((event) => {
          return event.eventType === "input.prompt";
        })
        .map((event) => {
          return chatEventDisplayText(event);
        });
      expect(promptTexts).toContain(failedPrompt);
      expect(promptTexts).toContain(cancelledPrompt);
      expect(promptTexts).toContain(recoveryPrompt);
    },
  );

  it(
    "chat-events-pi-activity-001 (1/5) launches personal Codex in Pi, captures tool activity summary, and preserves Memory version",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;
      const summaryPrompts: string[] = [];
      const summaryTitle = "Checking workspace files";
      fixture.chatCallbacks.mockVertexCompletions((body) => {
        summaryPrompts.push(
          body.messages
            .map((message) => {
              return message.content;
            })
            .join("\n"),
        );
        return summaryTitle;
      });

      const run = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: "Inspect the workspace notes and report back",
      });
      const { execution, sandboxHeaders } = await chatActor.runExecution(
        run.runId,
      );

      expect(execution.cliAgentType).toBe("pi");
      expect(execution.piSessionId).toBe(run.threadId);
      expect(execution.nativeContinuation).toStrictEqual({
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: null,
      });
      expect(execution.piLaunchConfig).toStrictEqual({ schemaVersion: 2 });
      expect(execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        dialect: "openai-codex-responses",
        model: "gpt-6-luna",
      });
      expect(execution.appendSystemPrompt).toContain(
        "You are currently running inside: Web",
      );
      expect(execution.appendSystemPrompt).toContain(
        CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
      );
      const selectedMemory = execution.startupInputs.memory;
      expect(selectedMemory).toMatchObject({
        missingRootPolicy: "preserveParentVersion",
      });
      if (!selectedMemory) {
        throw new Error("Expected a selected writeback Memory mount");
      }

      const cliCommand = "ls -la /home/user/workspace";
      const fileName = "workspace-audit.md";
      const beforeToolsText = "Scanning the workspace files in parallel.";
      const afterToolsText = "Finished auditing workspace-audit.md.";
      await chatActor.run(() => {
        return fixture.webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: run.threadId,
                sequenceNumber: 1,
              },
              {
                type: "assistant",
                sequenceNumber: 2,
                message: {
                  content: [
                    { type: "text", text: beforeToolsText },
                    {
                      type: "tool_use",
                      id: "tool-bash-1",
                      name: "Bash",
                      input: { command: cliCommand },
                    },
                    {
                      type: "tool_use",
                      id: "tool-read-1",
                      name: "Read",
                      input: { file_path: `/home/user/workspace/${fileName}` },
                    },
                  ],
                },
              },
              {
                type: "user",
                sequenceNumber: 3,
                message: {
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "tool-bash-1",
                      content: fileName,
                    },
                    {
                      type: "tool_result",
                      tool_use_id: "tool-read-1",
                      content: "Audit notes",
                    },
                  ],
                },
              },
              {
                type: "assistant",
                sequenceNumber: 4,
                message: {
                  content: [{ type: "text", text: afterToolsText }],
                },
              },
              {
                type: "result",
                sequenceNumber: 5,
                result: afterToolsText,
              },
            ],
          },
          sandboxHeaders,
          [200],
        );
      });
      await flushWaitUntilForTest();

      const summary = await chatActor.run(() => {
        return accept(
          summaryClient.summarize({
            headers: fixture.sessionHeaders(actor),
            params: { id: run.threadId },
            body: { runId: run.runId },
          }),
          [200],
        );
      });
      expect(summary.body).toStrictEqual({
        runId: run.runId,
        status: "available",
        messages: [{ id: summaryTitle, text: summaryTitle }],
      });
      expect(summaryPrompts.join("\n")).toContain(cliCommand);
      expect(summaryPrompts.join("\n")).toContain(fileName);

      const completed = await chatActor.run(() => {
        return fixture.webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 0,
            lastEventSequence: 5,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: run.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
          sandboxHeaders,
          [200],
        );
      });
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await flushWaitUntilForTest();

      const [threadEvents, storedRun] = await Promise.all([
        fixture.chat.listThreadEvents(actor, run.threadId),
        fixture.api.readRun(actor, run.runId),
      ]);

      expect(
        eventBackedContents(threadEvents.events, run.runId).map((message) => {
          return chatEventDisplayText(message);
        }),
      ).toStrictEqual([beforeToolsText, afterToolsText]);

      expect(storedRun.status).toBe("completed");
      expect(storedRun.result).toMatchObject({
        framework: "pi",
        frameworkSessionId: run.threadId,
        storageOutputs: [
          expect.objectContaining({
            name: "memory",
            version: selectedMemory.versionId,
            missingRootPolicy: "preserveParentVersion",
          }),
        ],
      });
    },
  );

  it(
    "chat-events-pi-activity-001 (2/5) replays Pi completion and outputs idempotently while rejecting conflicting session or framework writes",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;

      const run = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: "Complete Pi session and verify idempotent replays",
      });
      const { sandboxHeaders } = await chatActor.runExecution(run.runId);

      await chatActor.run(() => {
        return fixture.webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: run.threadId,
                sequenceNumber: 1,
              },
            ],
          },
          sandboxHeaders,
          [200],
        );
      });

      const completion = {
        cliAgentType: "pi" as const,
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryDisposition: "native_only" as const,
      };
      const completed = await chatActor.run(() => {
        return fixture.webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 0,
            lastEventSequence: 1,
            completion,
          },
          sandboxHeaders,
          [200],
        );
      });
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await flushWaitUntilForTest();

      const storedRun = await fixture.api.readRun(actor, run.runId);
      const outputReplay = await chatActor.run(() => {
        return fixture.webhooks.requestAgentRunOutputs(
          { runId: run.runId, ...completion },
          sandboxHeaders,
          [200],
        );
      });
      const completionReplay = await chatActor.run(() => {
        return fixture.webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 0,
            lastEventSequence: 1,
            completion,
          },
          sandboxHeaders,
          [200],
        );
      });

      expect(outputReplay.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      expect(completionReplay.body).toStrictEqual({
        success: true,
        status: "completed",
      });

      await chatActor.run(() => {
        return fixture.webhooks.requestAgentRunOutputs(
          {
            runId: run.runId,
            cliAgentType: "pi",
            cliAgentSessionId: randomUUID(),
            cliAgentSessionHistoryDisposition: "native_only",
          },
          sandboxHeaders,
          [400],
        );
      });
      await chatActor.run(() => {
        return fixture.webhooks.requestAgentRunOutputs(
          {
            runId: run.runId,
            cliAgentType: "claude-code",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
          sandboxHeaders,
          [400],
        );
      });

      const unchangedRun = await fixture.api.readRun(actor, run.runId);
      expect(unchangedRun.result).toStrictEqual(storedRun.result);
    },
  );

  it(
    "chat-events-pi-activity-001 (4/5) records an initialized Pi failure, replays identically, and resumes its generation on the next Pi Run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;

      const run1 = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: "Initialize Pi then fail mid-turn",
      });
      const exec1 = await chatActor.runExecution(run1.runId);
      await chatActor.run(() => {
        return fixture.webhooks.requestAgentEvents(
          {
            runId: run1.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: run1.threadId,
                sequenceNumber: 1,
              },
            ],
          },
          exec1.sandboxHeaders,
          [200],
        );
      });

      const failureCompletion = {
        runId: run1.runId,
        exitCode: 1,
        error: "Pi turn failed after session init",
        failureReason: "provider_server_error" as const,
        completion: {
          cliAgentType: "pi" as const,
          cliAgentSessionId: run1.threadId,
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };
      const firstFailure = await chatActor.run(() => {
        return fixture.webhooks.requestAgentComplete(
          failureCompletion,
          exec1.sandboxHeaders,
          [200],
        );
      });
      expect(firstFailure.body).toStrictEqual({
        success: true,
        status: "failed",
      });
      await fixture.waitForRunStatus(actor, run1.runId, "failed");

      const replayedFailure = await chatActor.run(() => {
        return fixture.webhooks.requestAgentComplete(
          failureCompletion,
          exec1.sandboxHeaders,
          [200],
        );
      });
      expect(replayedFailure.body).toStrictEqual({
        success: true,
        status: "failed",
      });

      const run2 = await chatActor.sendChatRun(actor, {
        threadId: run1.threadId,
        model: "gpt-6-luna",
        prompt: "Continue from the initialized failed Pi turn",
      });
      const exec2 = await chatActor.runExecution(run2.runId);
      expect(exec2.execution.cliAgentType).toBe("pi");
      expect(exec2.execution.piSessionId).toBe(run1.threadId);
      expect(exec2.execution.nativeContinuation.sessionId).toBe(run1.threadId);
      expect(exec2.execution.nativeContinuation.generationRunId).toBe(
        run1.runId,
      );
      expect(exec2.execution.nativeContinuation.recoveryPrompt).toContain(
        CHAT_RECOVERY_COMMAND_SNIPPET,
      );
    },
  );

  it(
    "chat-events-pi-activity-001 (5/5) launches Claude Code on the same thread without Pi session fields and with Chat recovery guidance",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context, {
        includePersonalClaude: true,
      });
      const { actor, fixture } = chatActor;

      const piRun = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: "Start the thread on personal Codex via Pi",
      });
      const piExec = await chatActor.runExecution(piRun.runId);
      await chatActor.run(() => {
        return fixture.webhooks.requestAgentEvents(
          {
            runId: piRun.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: piRun.threadId,
                sequenceNumber: 1,
              },
            ],
          },
          piExec.sandboxHeaders,
          [200],
        );
      });
      await chatActor.run(() => {
        return fixture.completeChatRunOk(piRun.runId, piExec.sandboxHeaders, {
          cliAgentType: "pi",
          cliAgentSessionId: piRun.threadId,
        });
      });
      await fixture.waitForRunStatus(actor, piRun.runId, "completed");

      const claudeRun = await chatActor.sendChatRun(actor, {
        threadId: piRun.threadId,
        model: "claude-fable-5-1",
        prompt: "Switch the thread to Claude Code",
      });
      const claudeExec = await chatActor.runExecution(claudeRun.runId);

      expect(claudeExec.execution.cliAgentType).toBe("claude-code");
      expect(claudeExec.execution.piSessionId).toBeUndefined();
      expect(claudeExec.execution.piLaunchConfig).toBeUndefined();
      expect(claudeExec.execution.piModelConfig).toBeUndefined();
      expect(claudeExec.execution.nativeContinuation.sessionId).toBeNull();
      expect(
        claudeExec.execution.nativeContinuation.generationRunId,
      ).toBeNull();
      expect(claudeExec.execution.nativeContinuation.recoveryPrompt).toContain(
        CHAT_RECOVERY_COMMAND_SNIPPET,
      );
    },
  );
});
