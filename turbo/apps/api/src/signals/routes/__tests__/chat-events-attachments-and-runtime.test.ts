import { randomUUID } from "node:crypto";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  customConnectorByIdContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  runWebhookContract,
  webhookCompleteContract,
  webhookEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { MsgPack } from "ably/modular";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { array, literal, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  buildArtifactKeyV2,
  buildArtifactPrefixV2,
} from "../../../lib/file-url";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../lib/secret-kms-client";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadRoutes } from "../chat-threads";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import {
  manualHttpCustomConnectorCreateBody,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const bdd = createBddApi(context);
const fixture = createChatEventsFixture(context);

const sharedApp = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...chatThreadRoutes,
    ...chatThreadGetRoutes,
    ...uploadsPrepareRoutes,
    ...uploadsCompleteRoutes,
    ...workflowsRoutes,
    ...workflowAutomationsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsDeleteRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentEventsRoutes,
    ...webhooksAgentFirewallAuthRoutes,
  ],
});
const chatEventsApi = sharedApp(chatEventsContract);
const chatThreadEventsApi = sharedApp(chatThreadEventsContract);
const chatThreadMetadataApi = sharedApp(chatThreadMetadataContract);
const chatThreadsApi = sharedApp(chatThreadsContract);
const uploadsApi = sharedApp(uploadsContract);
const workflowsApi = sharedApp(workflowsCollectionContract);
const workflowAutomationsApi = sharedApp(workflowAutomationsContract);
const customConnectorsApi = sharedApp(customConnectorsContract);
const customConnectorByIdApi = sharedApp(customConnectorByIdContract);
const runsByIdApi = sharedApp(runsByIdContract);
const runsCancelApi = sharedApp(runsCancelContract);
const webhookEventsApi = sharedApp(webhookEventsContract);
const webhookCompleteApi = sharedApp(webhookCompleteContract);
const firewallWebhookApi = sharedApp(runWebhookContract);

const VALID_TEST_ABLY_KEY = "wakeup.key:wakeup-synthetic-secret";

const ablyBatchRequestSchema = array(
  object({
    channels: array(string()),
    messages: array(
      object({
        name: string(),
        data: string(),
        encoding: literal("json"),
      }),
    ),
  }),
);

const connectorRuntimeWakeupPayloadSchema = object({
  runId: string(),
  target: object({
    kind: literal("custom"),
    customConnectorId: string(),
  }),
});

function s3NotFoundError(): Error {
  return Object.assign(new Error("NotFound"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function decodeAblyMsgPack(body: ArrayBuffer): unknown {
  if (
    typeof MsgPack !== "object" ||
    MsgPack === null ||
    !("decode" in MsgPack) ||
    typeof MsgPack.decode !== "function"
  ) {
    throw new Error("Expected native Ably MessagePack decoder");
  }
  return MsgPack.decode(body);
}

function encodeAblyMsgPack(value: unknown): ArrayBuffer {
  if (
    typeof MsgPack !== "object" ||
    MsgPack === null ||
    !("encode" in MsgPack) ||
    typeof MsgPack.encode !== "function"
  ) {
    throw new Error("Expected native Ably MessagePack encoder");
  }
  const encoded: unknown = MsgPack.encode(value);
  if (!(encoded instanceof ArrayBuffer)) {
    throw new Error("Expected Ably MessagePack ArrayBuffer output");
  }
  return encoded;
}

function configureBaseChatEnvironment(): void {
  // Ensure the Ably singleton captures a valid appId.keyId:secret format on first use.
  mockEnv("ABLY_API_KEY", VALID_TEST_ABLY_KEY);
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  fixture.chatCallbacks.disableVapid();
}

function createRunTracker(actor: ApiTestUser) {
  const activeRuns = new Map<string, string | undefined>();
  onTestFinished(async () => {
    if (activeRuns.size === 0) {
      return;
    }
    context.mocks.ably.publish.mockResolvedValue(undefined);
    for (const [runId, sandboxToken] of activeRuns) {
      await settleIncludingAbort(
        accept(
          runsCancelApi.cancel({
            headers: fixture.sessionHeaders(actor),
            params: { id: runId },
          }),
          [200],
        ),
      );
      if (sandboxToken) {
        await settleIncludingAbort(
          accept(
            webhookCompleteApi.complete({
              headers: { authorization: `Bearer ${sandboxToken}` },
              body: {
                runId,
                exitCode: 1,
                error: "Run cancelled by test cleanup",
              },
            }),
            [200],
          ),
        );
      }
    }
    await settleIncludingAbort(flushWaitUntilForTest);
  });
  return {
    track(runId: string, sandboxToken?: string): void {
      activeRuns.set(runId, sandboxToken);
    },
    markDone(runId: string): void {
      activeRuns.delete(runId);
    },
  };
}

async function listProjectedEvents(actor: ApiTestUser, threadId: string) {
  const response = await accept(
    chatThreadEventsApi.rows({
      headers: fixture.sessionHeaders(actor),
      params: { threadId },
      query: { sinceSeqId: 0, limit: 50 },
    }),
    [200],
  );
  return projectChatEventRows(response.body.rows);
}

async function readRunDetail(actor: ApiTestUser, runId: string) {
  const response = await accept(
    runsByIdApi.getById({
      headers: fixture.sessionHeaders(actor),
      params: { id: runId },
    }),
    [200],
  );
  return response.body;
}

async function sendAndLaunchRun(
  actor: ApiTestUser,
  body: Parameters<typeof chatEventsApi.send>[0]["body"],
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const clientEventId = body.clientEventId ?? randomUUID();
  const sent = await accept(
    chatEventsApi.send({
      headers: fixture.sessionHeaders(actor),
      body: { ...body, clientEventId },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  const events = await listProjectedEvents(actor, sent.body.threadId);
  const launched = userMessages(events).find((message) => {
    return (
      message.revokesEventId === clientEventId && message.runId !== undefined
    );
  });
  if (!launched?.runId) {
    throw new Error("Expected chat send to launch a run");
  }
  return { runId: launched.runId, threadId: sent.body.threadId };
}

async function lastAutomationRunId(
  actor: ApiTestUser,
  threadId: string,
): Promise<string> {
  await flushWaitUntilForTest();
  const events = await listProjectedEvents(actor, threadId);
  const matched = [...events].reverse().find((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.userMessage.parts.some((part) => {
        return part.type === "automation";
      })
    );
  });
  if (matched?.eventType !== "input.prompt" || !matched.runId) {
    throw new Error("Expected an admitted automation run");
  }
  return matched.runId;
}

async function completePiRunOnce(args: {
  readonly runId: string;
  readonly threadId: string;
  readonly answer: string;
  readonly sandboxHeaders: { readonly authorization: string };
}): Promise<void> {
  await accept(
    webhookEventsApi.send({
      headers: args.sandboxHeaders,
      body: {
        runId: args.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: { content: [{ type: "text", text: args.answer }] },
          },
          { type: "result", sequenceNumber: 2, result: args.answer },
        ],
      },
    }),
    [200],
  );
  await accept(
    webhookCompleteApi.complete({
      headers: args.sandboxHeaders,
      body: {
        runId: args.runId,
        exitCode: 0,
        lastEventSequence: 2,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: args.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function prepareAndCompletePrivateUpload(
  actor: ApiTestUser,
  args: {
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
  },
) {
  const prepared = await accept(
    uploadsApi.prepare({
      headers: fixture.sessionHeaders(actor),
      body: args,
    }),
    [200],
  );
  const previousS3 = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof HeadObjectCommand &&
      typeof command.input.Key === "string" &&
      command.input.Key.includes(prepared.body.id)
    ) {
      return Promise.resolve({
        ContentLength: args.size,
        ContentType: args.contentType,
        LastModified: nowDate(),
      });
    }
    return previousS3?.(command) ?? Promise.resolve({});
  });
  await accept(
    uploadsApi.complete({
      headers: fixture.sessionHeaders(actor),
      body: { id: prepared.body.id },
    }),
    [200],
  );
  if (previousS3) {
    context.mocks.s3.send.mockImplementation(previousS3);
  }
  return prepared.body;
}

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const missingId = randomUUID();
  await Promise.all([
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
      chatThreadsApi.create({
        headers: {},
        body: { title: "warmup" },
      }),
      [401],
    ),
    accept(
      uploadsApi.prepare({
        headers: {},
        body: { filename: "warmup.png", contentType: "image/png", size: 1 },
      }),
      [401],
    ),
    accept(
      uploadsApi.complete({
        headers: {},
        body: { id: missingId },
      }),
      [401],
    ),
    accept(
      workflowsApi.create({
        headers: {},
        body: { name: "warmup-workflow", visibility: "private" },
      }),
      [401],
    ),
    accept(
      workflowAutomationsApi.listWorkspace({
        headers: {},
      }),
      [401],
    ),
    accept(
      customConnectorsApi.list({
        headers: {},
      }),
      [401],
    ),
    accept(
      customConnectorByIdApi.delete({
        headers: {},
        params: { id: missingId },
      }),
      [401],
    ),
    accept(
      runsByIdApi.getById({
        headers: {},
        params: { id: missingId },
      }),
      [401],
    ),
    accept(
      runsCancelApi.cancel({
        headers: {},
        params: { id: missingId },
      }),
      [401],
    ),
    accept(
      webhookEventsApi.send({
        headers: {},
        body: {
          runId: missingId,
          events: [{ type: "result", sequenceNumber: 0, result: "warmup" }],
        },
      }),
      [401],
    ),
    accept(
      webhookCompleteApi.complete({
        headers: {},
        body: { runId: missingId, exitCode: 0 },
      }),
      [401],
    ),
    accept(
      firewallWebhookApi.firewallAuth({
        headers: {},
        body: { authHeaders: {} },
      }),
      [401],
    ),
  ]);
});

describe("thread-bound Pi Automation execution and effort", () => {
  it(
    "chat-events-automations-002 (1/2) captures automation effort at enqueue while later edits update thread metadata",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      mockClaudeCodeTokenEndpoint();
      fixture.bdd.acceptStorageWrites();

      const [workflow] = await Promise.all([
        accept(
          workflowsApi.create({
            headers: fixture.sessionHeaders(actor),
            body: {
              name: `loop-effort-${randomUUID().slice(0, 8)}`,
              visibility: "private",
            },
          }),
          [201],
        ),
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor, { tier: "pro" }),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: "bdd-personal-claude-token",
        }),
      ]);

      await fixture.api.updateUserModelPreference(actor, "claude-fable-5-1");
      const created = await accept(
        workflowAutomationsApi.create({
          headers: fixture.sessionHeaders(actor),
          params: { workflowId: workflow.body.id },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 300 },
          },
        }),
        [201],
      );
      const automationId = created.body.id;

      // Given: first loop automation Run is active with default reasoning effort max.
      const firstLaunch = await accept(
        workflowAutomationsApi.run({
          headers: fixture.sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(firstLaunch.body.runId).toBeNull();
      const threadId = firstLaunch.body.chatThreadId;
      const firstRunId = await lastAutomationRunId(actor, threadId);
      const firstExecution = await fixture.runExecution(firstRunId);
      tracker.track(firstRunId, firstExecution.execution.sandboxToken);
      expect(
        firstExecution.execution.platformEnvironment?.OKOU_REASONING_EFFORT,
      ).toBe("max");

      // When: save extra effort, launch queued automation input, save high effort, complete Run 1.
      await fixture.chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-fable-5-1",
        { reasoningEffort: "extra" },
      );

      const queuedLaunch = await accept(
        workflowAutomationsApi.run({
          headers: fixture.sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(queuedLaunch.body.runId).toBeNull();
      expect(queuedLaunch.body.chatThreadId).toBe(threadId);

      await fixture.chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-fable-5-1",
        { reasoningEffort: "high" },
      );

      await accept(
        webhookCompleteApi.complete({
          headers: firstExecution.sandboxHeaders,
          body: {
            runId: firstRunId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `bdd-cli-${firstRunId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      tracker.markDone(firstRunId);

      const promotedRunId = await lastAutomationRunId(actor, threadId);
      expect(promotedRunId).not.toBe(firstRunId);

      const [promotedExecution, threadMetadata] = await Promise.all([
        fixture.runExecution(promotedRunId),
        accept(
          chatThreadMetadataApi.get({
            headers: fixture.sessionHeaders(actor),
            params: { id: threadId },
          }),
          [200],
        ),
      ]);
      tracker.track(promotedRunId, promotedExecution.execution.sandboxToken);
      expect(
        promotedExecution.execution.platformEnvironment?.OKOU_REASONING_EFFORT,
      ).toBe("extra");
      expect(
        threadMetadata.body.modelSettings["claude-fable-5-1"],
      ).toStrictEqual({
        effort: "high",
      });
    },
  );

  it(
    "chat-events-automations-002 (2/2) applies saved high effort to a fresh automation trigger after cancelling an active Run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      mockClaudeCodeTokenEndpoint();
      fixture.bdd.acceptStorageWrites();

      const [workflow] = await Promise.all([
        accept(
          workflowsApi.create({
            headers: fixture.sessionHeaders(actor),
            body: {
              name: `loop-effort-fresh-${randomUUID().slice(0, 8)}`,
              visibility: "private",
            },
          }),
          [201],
        ),
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor, { tier: "pro" }),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: "bdd-personal-claude-token",
        }),
      ]);

      await fixture.api.updateUserModelPreference(actor, "claude-fable-5-1");
      const created = await accept(
        workflowAutomationsApi.create({
          headers: fixture.sessionHeaders(actor),
          params: { workflowId: workflow.body.id },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 300 },
          },
        }),
        [201],
      );
      const automationId = created.body.id;

      const firstLaunch = await accept(
        workflowAutomationsApi.run({
          headers: fixture.sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      const threadId = firstLaunch.body.chatThreadId;
      const firstRunId = await lastAutomationRunId(actor, threadId);
      const firstExecution = await fixture.runExecution(firstRunId);
      tracker.track(firstRunId, firstExecution.execution.sandboxToken);

      await fixture.chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-fable-5-1",
        { reasoningEffort: "high" },
      );

      await accept(
        runsCancelApi.cancel({
          headers: fixture.sessionHeaders(actor),
          params: { id: firstRunId },
        }),
        [200],
      );
      await accept(
        webhookCompleteApi.complete({
          headers: firstExecution.sandboxHeaders,
          body: {
            runId: firstRunId,
            exitCode: 1,
            error: "Run cancelled",
          },
        }),
        [200],
      );
      tracker.markDone(firstRunId);
      await flushWaitUntilForTest();

      const freshLaunch = await accept(
        workflowAutomationsApi.run({
          headers: fixture.sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(freshLaunch.body.runId).toBeNull();
      const freshRunId = await lastAutomationRunId(actor, threadId);
      expect(freshRunId).not.toBe(firstRunId);

      const freshExecution = await fixture.runExecution(freshRunId);
      tracker.track(freshRunId, freshExecution.execution.sandboxToken);
      expect(
        freshExecution.execution.platformEnvironment?.OKOU_REASONING_EFFORT,
      ).toBe("high");
    },
  );

  it(
    "chat-events-automations-001 rotates a signed event Automation session into Pi and preserves its user conversation",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      mockClaudeCodeTokenEndpoint();
      fixture.bdd.acceptStorageWrites();
      fixture.mockPiObjectStore();
      fixture.mockPiResourceArchiveDownloads();

      const [workflow] = await Promise.all([
        accept(
          workflowsApi.create({
            headers: fixture.sessionHeaders(actor),
            body: {
              name: `pi-rotate-${randomUUID().slice(0, 8)}`,
              visibility: "private",
            },
          }),
          [201],
        ),
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor, { tier: "team" }),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: "bdd-personal-claude-token",
        }),
      ]);

      await fixture.api.updateUserModelPreference(actor, "claude-fable-5-1");
      const created = await accept(
        workflowAutomationsApi.create({
          headers: fixture.sessionHeaders(actor),
          params: { workflowId: workflow.body.id },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      const automation = created.body;
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

      // Given: complete a first Claude Code turn and configure personal gpt-6-luna.
      const firstDelivery = await fixture.postThreadPiAutomationEvent({
        webhookUrl: automation.webhookUrl,
        webhookSecret: automation.webhookSecret,
        payload: "initial-claude-turn",
        timestamp: Math.floor(now() / 1000),
      });
      expect(firstDelivery).toStrictEqual({ success: true, duplicate: false });

      const firstRunId = await lastAutomationRunId(actor, threadId);
      const [firstExecution] = await Promise.all([
        fixture.runExecution(firstRunId),
        fixture.connectSubscriptionPiModel(actor, {
          accountId: "luna-rotation-account",
        }),
      ]);
      tracker.track(firstRunId, firstExecution.execution.sandboxToken);
      expect(firstExecution.execution.cliAgentType).toBe("claude-code");

      await accept(
        webhookCompleteApi.complete({
          headers: firstExecution.sandboxHeaders,
          body: {
            runId: firstRunId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `claude-session-${firstRunId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      tracker.markDone(firstRunId);
      await flushWaitUntilForTest();

      // When: switch the automation thread to gpt-6-luna, post and replay a signed event.
      await fixture.chat.updateThreadModelSelection(
        actor,
        threadId,
        "gpt-6-luna",
      );

      const rotatedTimestamp = Math.floor(now() / 1000) + 1;
      const rotatedEvent = await fixture.postThreadPiAutomationEvent({
        webhookUrl: automation.webhookUrl,
        webhookSecret: automation.webhookSecret,
        payload: "rotated-pi-event",
        timestamp: rotatedTimestamp,
      });
      expect(rotatedEvent).toStrictEqual({ success: true, duplicate: false });

      const replayedEvent = await fixture.postThreadPiAutomationEvent({
        webhookUrl: automation.webhookUrl,
        webhookSecret: automation.webhookSecret,
        payload: "rotated-pi-event",
        timestamp: rotatedTimestamp,
      });
      expect(replayedEvent).toStrictEqual({ success: true, duplicate: true });

      const secondRunId = await lastAutomationRunId(actor, threadId);
      expect(secondRunId).not.toBe(firstRunId);

      const secondExecution = await fixture.runExecution(secondRunId);
      tracker.track(secondRunId, secondExecution.execution.sandboxToken);
      expect(secondExecution.execution.cliAgentType).toBe("pi");
      expect(secondExecution.execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6-luna",
      });
      expect(secondExecution.execution.piSessionId).toBe(threadId);

      await completePiRunOnce({
        runId: secondRunId,
        threadId,
        answer: "Handled rotated webhook event in Pi",
        sandboxHeaders: secondExecution.sandboxHeaders,
      });
      tracker.markDone(secondRunId);

      // Then send a user prompt to the same thread and verify Pi continuation.
      const thirdRun = await sendAndLaunchRun(actor, {
        threadId,
        prompt: "Summarize the rotated automation run",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Summarize the rotated automation run" },
          ],
        },
      });
      expect(thirdRun.runId).not.toBe(secondRunId);

      const thirdExecution = await fixture.runExecution(thirdRun.runId);
      tracker.track(thirdRun.runId, thirdExecution.execution.sandboxToken);
      expect(thirdExecution.execution.cliAgentType).toBe("pi");
      expect(thirdExecution.execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6-luna",
      });
      expect(thirdExecution.execution.piSessionId).toBe(threadId);

      await completePiRunOnce({
        runId: thirdRun.runId,
        threadId,
        answer: "Preserved thread conversation in Pi",
        sandboxHeaders: thirdExecution.sandboxHeaders,
      });
      tracker.markDone(thirdRun.runId);
      const [secondReadback, thirdReadback, eventsAfterThird] =
        await Promise.all([
          readRunDetail(actor, secondRunId),
          readRunDetail(actor, thirdRun.runId),
          listProjectedEvents(actor, threadId),
        ]);
      expect(secondReadback.status).toBe("completed");
      expect(secondReadback.result?.frameworkSessionId).toBe(threadId);
      expect(thirdReadback.status).toBe("completed");
      expect(thirdReadback.result?.frameworkSessionId).toBe(threadId);
      for (const runId of [secondRunId, thirdRun.runId]) {
        expect(
          eventsAfterThird
            .filter((event) => {
              return (
                event.runId === runId &&
                isChatRunTerminalEventType(event.eventType)
              );
            })
            .map((event) => {
              return event.eventType;
            }),
        ).toStrictEqual(["run.completed"]);
      }
    },
  );

  it(
    "chat-events-automations-004 settles a user-owned automation failed once without Built-in charges",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      fixture.bdd.acceptStorageWrites();
      fixture.mockPiObjectStore();
      fixture.mockPiResourceArchiveDownloads();

      const [workflow] = await Promise.all([
        accept(
          workflowsApi.create({
            headers: fixture.sessionHeaders(actor),
            body: {
              name: `pi-fail-once-${randomUUID().slice(0, 8)}`,
              visibility: "private",
            },
          }),
          [201],
        ),
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor),
        fixture.configureSubscriptionPiModel(
          actor,
          { accountId: "sol-failure-account" },
          "gpt-6.1-sol",
        ),
      ]);

      const created = await accept(
        workflowAutomationsApi.create({
          headers: fixture.sessionHeaders(actor),
          params: { workflowId: workflow.body.id },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 300 },
          },
        }),
        [201],
      );
      const launched = await accept(
        workflowAutomationsApi.run({
          headers: fixture.sessionHeaders(actor),
          params: { id: created.body.id },
        }),
        [201],
      );
      const threadId = launched.body.chatThreadId;
      const runId = await lastAutomationRunId(actor, threadId);
      const execution = await fixture.runExecution(runId);
      tracker.track(runId, execution.execution.sandboxToken);
      expect(execution.execution.cliAgentType).toBe("pi");
      expect(execution.execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6.1-sol",
      });

      // When: Sandbox reports failure and retries the failed completion.
      await accept(
        webhookCompleteApi.complete({
          headers: execution.sandboxHeaders,
          body: {
            runId,
            exitCode: 1,
            error: "Pi sandbox exited with failure",
          },
        }),
        [200],
      );
      tracker.markDone(runId);
      await accept(
        webhookCompleteApi.complete({
          headers: execution.sandboxHeaders,
          body: {
            runId,
            exitCode: 1,
            error: "Pi sandbox exited with failure",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const events = await listProjectedEvents(actor, threadId);
      const terminalTypes = events
        .filter((event) => {
          return (
            event.runId === runId && isChatRunTerminalEventType(event.eventType)
          );
        })
        .map((event) => {
          return event.eventType;
        });
      expect(terminalTypes).toStrictEqual(["run.failed"]);
      await expectThreadModelCredits(context, actor, threadId, 0);
    },
  );
});

describe("chat attachment lookup ownership", () => {
  it(
    "chat-events-attachment-lookups-002 shares storage reads across different filename hints and retains their snapshots",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      fixture.mockPiObjectStore();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        bdd.bootstrapLimitedFreeOnboarding(actor),
      ]);

      // Allocate a public V2 image object (orgId omitted -> public artifacts bucket).
      const publicUpload = await accept(
        uploadsApi.prepare({
          headers: fixture.sessionHeaders({ ...actor, orgId: null }),
          body: {
            filename: "current.png",
            contentType: "image/png",
            size: 128,
          },
        }),
        [200],
      );
      const fileId = publicUpload.body.id;
      // Distinct extensions produce distinct V2 lookup keys under the same prefix.
      const staleKey = buildArtifactKeyV2(fileId, "stale.jpg");
      const archivedKey = buildArtifactKeyV2(fileId, "archived.webp");
      const currentKey = buildArtifactKeyV2(fileId, "current.png");
      const artifactPrefix = buildArtifactPrefixV2(fileId);
      const publicBucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");

      const headKeys: string[] = [];
      const listPrefixes: string[] = [];
      const previousS3 = context.mocks.s3.send.getMockImplementation();
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Bucket === publicBucket &&
          typeof command.input.Key === "string" &&
          command.input.Key.startsWith(artifactPrefix)
        ) {
          headKeys.push(command.input.Key);
          if (command.input.Key === currentKey) {
            return Promise.resolve({
              ContentLength: 128,
              ContentType: "image/png",
              LastModified: nowDate(),
              Metadata: {
                "artifact-id": fileId,
                "user-id": encodeURIComponent(actor.userId),
                filename: encodeURIComponent("current.png"),
                "public-brand": "okou",
              },
            });
          }
          return Promise.reject(s3NotFoundError());
        }
        if (
          command instanceof ListObjectsV2Command &&
          command.input.Bucket === publicBucket &&
          command.input.Prefix === artifactPrefix
        ) {
          listPrefixes.push(command.input.Prefix);
          return Promise.resolve({
            Contents: [
              {
                Key: currentKey,
                Size: 128,
                LastModified: nowDate(),
              },
            ],
            IsTruncated: false,
          });
        }
        return previousS3?.(command) ?? Promise.resolve({});
      });

      const sentRun = await sendAndLaunchRun(actor, {
        model: null,
        prompt: "Inspect all three filename snapshots",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Inspect all three filename snapshots" },
            {
              type: "file",
              fileId,
              filenameSnapshot: "stale.jpg",
              contentType: "image/png",
            },
            {
              type: "file",
              fileId,
              filenameSnapshot: "archived.webp",
              contentType: "image/png",
            },
            {
              type: "file",
              fileId,
              filenameSnapshot: "current.png",
              contentType: "image/png",
            },
          ],
        },
      });
      tracker.track(sentRun.runId);

      expect([...headKeys].sort()).toStrictEqual(
        [staleKey, archivedKey, currentKey].sort(),
      );
      expect(listPrefixes).toStrictEqual([artifactPrefix]);

      const readback = await readRunDetail(actor, sentRun.runId);
      expect(readback.prompt).toContain("[Web file] stale.jpg (image/png)");
      expect(readback.prompt).toContain("[Web file] archived.webp (image/png)");
      expect(readback.prompt).toContain("[Web file] current.png (image/png)");
      expect(readback.prompt).toContain(`[ID] ${fileId}`);
    },
  );

  it(
    "chat-events-attachment-lookups-003 does not reuse private attachment authorization for a different user",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const ownerActor = fixture.bdd.user();
      if (!ownerActor.orgId) {
        throw new Error("Expected owner workspace orgId");
      }
      const otherUser = fixture.bdd.user({
        orgId: ownerActor.orgId,
        orgRole: "org:member",
      });
      const tracker = createRunTracker(ownerActor);
      configureBaseChatEnvironment();
      fixture.mockPiObjectStore();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        bdd.bootstrapLimitedFreeOnboarding(ownerActor),
      ]);
      const privateFile = await prepareAndCompletePrivateUpload(ownerActor, {
        filename: "private-note.txt",
        contentType: "text/plain",
        size: 32,
      });

      const ownerRun = await sendAndLaunchRun(ownerActor, {
        model: null,
        prompt: "Review private note",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Review private note" },
            {
              type: "file",
              fileId: privateFile.id,
              filenameSnapshot: "private-note.txt",
              contentType: "text/plain",
            },
          ],
        },
      });
      tracker.track(ownerRun.runId);

      const ownerReadback = await readRunDetail(ownerActor, ownerRun.runId);
      expect(ownerReadback.prompt).toContain(privateFile.id);

      const otherThread = await accept(
        chatThreadsApi.create({
          headers: fixture.sessionHeaders(otherUser),
          body: { title: "Peer thread", model: null },
        }),
        [201],
      );

      const deniedSend = await fixture.requestSendEventRaw(otherUser, {
        threadId: otherThread.body.id,
        prompt: "Reuse owner private attachment",
        hasTextContent: true,
        clientEventId: randomUUID(),
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Reuse owner private attachment" },
            {
              type: "file",
              fileId: privateFile.id,
              filenameSnapshot: "private-note.txt",
              contentType: "text/plain",
            },
          ],
        },
      });
      expect(deniedSend.status).toBe(500);
      expect(deniedSend.body).toStrictEqual({
        error: "Internal server error",
      });

      const otherThreadEvents = await listProjectedEvents(
        otherUser,
        otherThread.body.id,
      );
      expect(userMessages(otherThreadEvents)).toStrictEqual([]);
    },
  );

  it(
    "chat-events-attachment-lookups-004 does not reuse private attachment authorization for a different organization",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const ownerActor = fixture.bdd.user();
      const sameUserOtherOrg = fixture.bdd.user({
        userId: ownerActor.userId,
        email: ownerActor.email,
      });
      const tracker = createRunTracker(ownerActor);
      configureBaseChatEnvironment();
      fixture.mockPiObjectStore();

      await Promise.all([
        fixture.api.configureRunnerGroup(),
        bdd.bootstrapLimitedFreeOnboarding(ownerActor),
      ]);
      const privateFile = await prepareAndCompletePrivateUpload(ownerActor, {
        filename: "org-only.txt",
        contentType: "text/plain",
        size: 40,
      });

      const ownerRun = await sendAndLaunchRun(ownerActor, {
        model: null,
        prompt: "Read org-scoped attachment",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Read org-scoped attachment" },
            {
              type: "file",
              fileId: privateFile.id,
              filenameSnapshot: "org-only.txt",
              contentType: "text/plain",
            },
          ],
        },
      });
      tracker.track(ownerRun.runId);

      const ownerReadback = await readRunDetail(ownerActor, ownerRun.runId);
      expect(ownerReadback.prompt).toContain(privateFile.id);

      const otherOrgThread = await accept(
        chatThreadsApi.create({
          headers: fixture.sessionHeaders(sameUserOtherOrg),
          body: { title: "Other workspace thread", model: null },
        }),
        [201],
      );

      const deniedSend = await fixture.requestSendEventRaw(sameUserOtherOrg, {
        threadId: otherOrgThread.body.id,
        prompt: "Reuse private attachment in another org",
        hasTextContent: true,
        clientEventId: randomUUID(),
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Reuse private attachment in another org" },
            {
              type: "file",
              fileId: privateFile.id,
              filenameSnapshot: "org-only.txt",
              contentType: "text/plain",
            },
          ],
        },
      });
      expect(deniedSend.status).toBe(500);
      expect(deniedSend.body).toStrictEqual({
        error: "Internal server error",
      });

      const otherOrgEvents = await listProjectedEvents(
        sameUserOtherOrg,
        otherOrgThread.body.id,
      );
      expect(userMessages(otherOrgEvents)).toStrictEqual([]);
    },
  );
});

describe("connector failure isolation in dispatched Runs", () => {
  it(
    "connector-run-failure-isolation-002 keeps healthy connector and model access through completion after a deleted account",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const claudeSecret = "bdd-isolation-claude-token";
      const figmaSecret = "bdd-isolation-figma-pat";
      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      mockClaudeCodeTokenEndpoint();

      server.use(
        http.post(
          "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
          () => {
            return HttpResponse.json({
              code: 0,
              tenant_access_token: "bdd-lark-tenant-token",
              expire: 7200,
            });
          },
        ),
      );

      const [larkResponse, figmaResponse] = await Promise.all([
        fixture.connectors.requestManualGrant(
          actor,
          "lark",
          "api-token",
          {
            appId: "cli_bdd_lark_app",
            appSecret: "bdd-lark-app-secret",
          },
          { statuses: [200] },
        ),
        fixture.connectors.requestManualGrant(
          actor,
          "figma",
          "api-token",
          {
            accessToken: figmaSecret,
          },
          { statuses: [200] },
        ),
        fixture.api.configureRunnerGroup(),
        fixture.api.grantProEntitlement(actor),
        fixture.api.createPersonalModelProvider(actor, {
          type: "claude-code-oauth-token",
          secret: claudeSecret,
        }),
      ]);

      if (larkResponse.status !== 200 || figmaResponse.status !== 200) {
        throw new Error("Expected Lark and Figma manual grants to succeed");
      }
      const larkAccountId = larkResponse.body.connectionId;
      const figmaAccountId = figmaResponse.body.connectionId;

      const firstRun = await sendAndLaunchRun(actor, {
        model: "claude-fable-5-1",
        prompt: "Use Lark and Figma in this run",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Use Lark and Figma in this run" }],
        },
      });
      const firstExec = await fixture.runExecution(firstRun.runId);
      tracker.track(firstRun.runId, firstExec.execution.sandboxToken);
      expect(
        firstExec.execution.secretConnectorMetadataMap?.LARK_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: larkAccountId,
      });
      expect(
        firstExec.execution.secretConnectorMetadataMap?.FIGMA_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: figmaAccountId,
      });

      // Owner deletes the admitted Lark account while Run 1 is active.
      await fixture.connectors.deleteBuiltinConnectorAccount(
        actor,
        "lark",
        larkAccountId,
      );

      const firewallHeaders = {
        authorization: `Bearer ${firstExec.execution.firewallToken}`,
      };
      const sharedConnectorMaps = {
        secretConnectorMap: firstExec.execution.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          firstExec.execution.secretConnectorMetadataMap ?? undefined,
      };

      const [larkAuth, figmaAuth, modelAuth, firstRunning] = await Promise.all([
        accept(
          firewallWebhookApi.firewallAuth({
            headers: firewallHeaders,
            body: {
              authHeaders: {
                Authorization: `Bearer ${secretTemplate("LARK_TOKEN")}`,
              },
              authBase: "https://open.larksuite.com",
              ...sharedConnectorMaps,
            },
          }),
          [424],
        ),
        accept(
          firewallWebhookApi.firewallAuth({
            headers: firewallHeaders,
            body: {
              authHeaders: {
                "X-Figma-Token": secretTemplate("FIGMA_TOKEN"),
              },
              authBase: "https://api.figma.com",
              ...sharedConnectorMaps,
            },
          }),
          [200],
        ),
        accept(
          firewallWebhookApi.firewallAuth({
            headers: firewallHeaders,
            body: {
              authHeaders: {
                Authorization: `Bearer ${secretTemplate("CLAUDE_CODE_OAUTH_TOKEN")}`,
              },
              authBase: "https://api.anthropic.com/v1/messages",
              ...sharedConnectorMaps,
            },
          }),
          [200],
        ),
        readRunDetail(actor, firstRun.runId),
      ]);

      expect(larkAuth.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
      expect(figmaAuth.body.headers["X-Figma-Token"]).toBe(figmaSecret);
      expect(modelAuth.body.headers.Authorization).toBe(
        `Bearer ${claudeSecret}`,
      );
      expect(firstRunning.status).toBe("running");

      await accept(
        webhookCompleteApi.complete({
          headers: firstExec.sandboxHeaders,
          body: {
            runId: firstRun.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `bdd-cli-${firstRun.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      tracker.markDone(firstRun.runId);
      await flushWaitUntilForTest();
      expect((await readRunDetail(actor, firstRun.runId)).status).toBe(
        "completed",
      );

      // Subsequent run exposes Figma (not deleted Lark), runs, and completes.
      const secondRun = await sendAndLaunchRun(actor, {
        model: "claude-fable-5-1",
        prompt: "Continue working with Figma",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Continue working with Figma" }],
        },
      });
      const secondExec = await fixture.runExecution(secondRun.runId);
      tracker.track(secondRun.runId, secondExec.execution.sandboxToken);
      expect(secondExec.execution.environment?.FIGMA_TOKEN).toBeTruthy();
      expect(
        secondExec.execution.secretConnectorMetadataMap?.FIGMA_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: figmaAccountId,
      });
      expect(secondExec.execution.environment?.LARK_TOKEN).toBeUndefined();
      expect((await readRunDetail(actor, secondRun.runId)).status).toBe(
        "running",
      );

      await accept(
        webhookCompleteApi.complete({
          headers: secondExec.sandboxHeaders,
          body: {
            runId: secondRun.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `bdd-cli-${secondRun.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      tracker.markDone(secondRun.runId);
      await flushWaitUntilForTest();
      expect((await readRunDetail(actor, secondRun.runId)).status).toBe(
        "completed",
      );
    },
  );
});

describe("official connector runtime placeholders", () => {
  it(
    "connector-runtime-placeholders-001 dispatches all GitHub aliases without decrypting their secret and resolves auth on demand",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const previousKms = getSecretKmsClient();
      const kmsProbe = useSecretKmsProbe();
      onTestFinished(() => {
        setSecretKmsClientForTests(previousKms);
      });

      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      fixture.mockPiObjectStore();
      mockGitHubConnectorOAuth({ login: "placeholder-github-owner" });

      const [started] = await Promise.all([
        fixture.connectors.startOauth(actor, "github", "oauth"),
        fixture.api.configureRunnerGroup(),
        bdd.bootstrapLimitedFreeOnboarding(actor),
      ]);
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected GitHub OAuth authorization state");
      }
      const oauthCode = `gh-code-${randomUUID().slice(0, 8)}`;
      const realGithubAccessToken = `github-access-${oauthCode}`;
      await fixture.connectors.completeOauthCallback("github", {
        state,
        code: oauthCode,
      });

      const githubAccounts =
        await fixture.connectors.listBuiltinConnectorAccounts(actor, "github");
      const githubAccountId = githubAccounts[0]?.id;
      if (!githubAccountId) {
        throw new Error("Expected connected GitHub OAuth account");
      }

      const decryptCallsBeforeRun = kmsProbe.decryptCalls;

      const chatRun = await sendAndLaunchRun(actor, {
        model: null,
        prompt: "Inspect GitHub repository checks",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Inspect GitHub repository checks" }],
        },
      });
      const execution = await fixture.runExecution(chatRun.runId);
      tracker.track(chatRun.runId, execution.execution.sandboxToken);

      const githubTokenPlaceholder =
        execution.execution.environment?.GITHUB_TOKEN;
      const ghTokenPlaceholder = execution.execution.environment?.GH_TOKEN;
      expect(githubTokenPlaceholder).toBeTruthy();
      expect(ghTokenPlaceholder).toBe(githubTokenPlaceholder);
      expect(githubTokenPlaceholder).not.toBe(realGithubAccessToken);
      expect(JSON.stringify(execution.execution)).not.toContain(
        realGithubAccessToken,
      );
      expect(execution.execution.secretConnectorMap).toMatchObject({
        GITHUB_TOKEN: "github",
        GH_TOKEN: "github",
      });
      expect(execution.execution.secretConnectorMetadataMap).toMatchObject({
        GITHUB_TOKEN: { sourceType: "connector", sourceId: githubAccountId },
        GH_TOKEN: { sourceType: "connector", sourceId: githubAccountId },
      });
      expect(kmsProbe.decryptCalls).toBe(decryptCallsBeforeRun);

      const firewallHeaders = {
        authorization: `Bearer ${execution.execution.firewallToken}`,
      };
      const withoutReference = await accept(
        firewallWebhookApi.firewallAuth({
          headers: firewallHeaders,
          body: {
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("GITHUB_TOKEN")}`,
            },
            authBase: "https://api.github.com",
            secretConnectorMap: { GITHUB_TOKEN: "github" },
          },
        }),
        [424],
      );
      expect(withoutReference.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

      const withReference = await accept(
        firewallWebhookApi.firewallAuth({
          headers: firewallHeaders,
          body: {
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("GITHUB_TOKEN")}`,
            },
            authBase: "https://api.github.com",
            secretConnectorMap:
              execution.execution.secretConnectorMap ?? undefined,
            secretConnectorMetadataMap:
              execution.execution.secretConnectorMetadataMap ?? undefined,
          },
        }),
        [200],
      );
      expect(withReference.body.headers.Authorization).toBe(
        `Bearer ${realGithubAccessToken}`,
      );
      expect(kmsProbe.decryptCalls).toBeGreaterThan(decryptCallsBeforeRun);

      await completePiRunOnce({
        runId: chatRun.runId,
        threadId: chatRun.threadId,
        answer: "Checked GitHub repository",
        sandboxHeaders: execution.sandboxHeaders,
      });
      tracker.markDone(chatRun.runId);
      expect((await readRunDetail(actor, chatRun.runId)).status).toBe(
        "completed",
      );
    },
  );
});

describe("connector runtime wakeups", () => {
  it(
    "connector-runtime-wakeups-002 uses the native Ably HTTP batch contract: accepted",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const previousBatchMode = context.mocks.ably.useRealBatchPublish();
      onTestFinished(() => {
        context.mocks.ably.useRealBatchPublish.mockReturnValue(
          previousBatchMode,
        );
      });

      const actor = fixture.bdd.user();
      const tracker = createRunTracker(actor);
      configureBaseChatEnvironment();
      fixture.mockPiObjectStore();

      const [runnerGroup, , customConnector] = await Promise.all([
        fixture.api.configureRunnerGroup(),
        bdd.bootstrapLimitedFreeOnboarding(actor),
        accept(
          customConnectorsApi.create({
            headers: fixture.sessionHeaders(actor),
            body: manualHttpCustomConnectorCreateBody({
              displayName: "Wakeup Custom Connector",
              prefixTemplates: ["https://wakeup.example.test/api"],
            }),
          }),
          [201],
        ),
      ]);
      const customConnectorId = customConnector.body.id;

      const chatRun = await sendAndLaunchRun(actor, {
        model: null,
        prompt: "Keep running during custom connector deletion",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "text",
              text: "Keep running during custom connector deletion",
            },
          ],
        },
      });
      const execution = await fixture.api.executionInput(chatRun.runId);
      tracker.track(chatRun.runId, execution.sandboxToken);
      expect((await readRunDetail(actor, chatRun.runId)).status).toBe(
        "running",
      );

      const expectedChannel = `runner-group:${runnerGroup}`;
      const ablyRequests: {
        readonly contentType: string | null;
        readonly batches: ReturnType<typeof ablyBatchRequestSchema.parse>;
      }[] = [];

      context.mocks.ably.useRealBatchPublish.mockReturnValue(true);
      server.use(
        http.post(
          "https://main.realtime.ably.net/messages",
          async ({ request }) => {
            const decoded = ablyBatchRequestSchema.parse(
              decodeAblyMsgPack(await request.arrayBuffer()),
            );
            ablyRequests.push({
              contentType: request.headers.get("content-type"),
              batches: decoded,
            });
            const batchResponses = decoded.map((spec) => {
              return {
                successCount: spec.channels.length,
                failureCount: 0,
                results: spec.channels.map((channel) => {
                  return { channel, messageId: `msg-${randomUUID()}` };
                }),
              };
            });
            return HttpResponse.arrayBuffer(encodeAblyMsgPack(batchResponses), {
              status: 201,
              headers: { "content-type": "application/x-msgpack" },
            });
          },
        ),
      );

      const deleted = await accept(
        customConnectorByIdApi.delete({
          headers: fixture.sessionHeaders(actor),
          params: { id: customConnectorId },
        }),
        [204],
      );
      expect(deleted.status).toBe(204);
      await flushWaitUntilForTest();

      expect(ablyRequests).toHaveLength(1);
      expect(ablyRequests[0]?.contentType).toContain("application/x-msgpack");
      const batch = ablyRequests[0]?.batches[0];
      expect(batch?.channels).toStrictEqual([expectedChannel]);
      const wakeupMessage = batch?.messages.find((message) => {
        return message.name === "connector-runtime-sync";
      });
      if (!wakeupMessage) {
        throw new Error("Expected a connector-runtime-sync wakeup message");
      }
      const parsedPayload = connectorRuntimeWakeupPayloadSchema.parse(
        JSON.parse(wakeupMessage.data),
      );
      expect(parsedPayload).toStrictEqual({
        runId: chatRun.runId,
        target: { kind: "custom", customConnectorId },
      });

      const remaining = await accept(
        customConnectorsApi.list({
          headers: fixture.sessionHeaders(actor),
        }),
        [200],
      );
      expect(
        remaining.body.connectors.some((item) => {
          return item.id === customConnectorId;
        }),
      ).toBeFalsy();
    },
  );
});
