import type {
  ChatEvent,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { readThreadMessagesAfterBackgroundWork } from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { coolDownBuiltInRoutesThroughReports } from "./helpers/public-built-in-model-cooldown";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  registerBuiltInCandidateCooldownCleanup,
  resolveBuiltInModelRouteFixture,
  seedBuiltInModelCandidateKeys,
} from "./helpers/runtime-state";

// Public callback/cooldown contracts own a private real SQL database per case.
// Concurrent fixed-Auto readers must never observe this suite's provider reports.
const context = testContext();

const bdd = createBddApi(context);

const api = createRunsApi(context);

const chat = createChatFilesBddApi(context);

const webhooks = createWebhookCallbackApi(context);

const chatCallbacks = createChatCallbacksApi(context);

const AUTO_CANDIDATES = [
  { providerType: "openrouter-codex", upstreamModel: "@preset/okou-1-0" },
] as const;

type UserMessage = Extract<
  ChatEvent,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.rejected"
      | "control.interrupt"
      | "control.revoke";
  }
>;

type AssistantMessage = Exclude<ChatEvent, UserMessage>;

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
  readonly storage: {
    addObject(object: {
      readonly bucket: string;
      readonly key: string;
      readonly size: number;
    }): void;
  };
}

async function entitledChatActor(): Promise<EntitledChatActor> {
  const actor = bdd.user();
  const storage = chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat callback agent",
    description: "Exercises chat callback terminal processing.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId, storage };
}

async function startChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly clientEventId?: string;
    readonly threadId?: string;
    readonly selectedModel?: string;
    readonly userMessage?: UserMessageInputDocument;
    readonly revokesEventId?: string;
  },
): Promise<{
  readonly runId: string;
  readonly threadId: string;
  readonly messageId: string;
}> {
  const messageId = body.clientEventId ?? randomUUID();
  const selectedModel = body.selectedModel;
  const requestBody = {
    agentId: body.agentId,
    prompt: body.prompt,
    clientEventId: messageId,
    ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
    ...(body.userMessage === undefined
      ? {}
      : { userMessage: body.userMessage }),
    ...(body.revokesEventId === undefined
      ? {}
      : { revokesEventId: body.revokesEventId }),
    ...(selectedModel === undefined ? {} : { model: selectedModel }),
  };
  const sent = await chat.requestSendEvent(actor, requestBody, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  let runId: string | null | undefined = sent.body.runId;
  if (runId === null) {
    // A terminal callback may claim the queued row between enqueue and the
    // inline dispatch decision. Recover as a refreshed client does: read the
    // appended replacement instead of retrying the client message id.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId && message.runId !== undefined
          );
        });
      },
    );
    runId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId;
    })?.runId;
  }
  if (runId === undefined || runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return {
    runId,
    threadId: sent.body.threadId,
    messageId,
  };
}

async function queueChatEvent(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly userMessage?: UserMessageInputDocument;
  },
): Promise<string> {
  const messageId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: body.agentId,
      threadId: body.threadId,
      prompt: body.prompt,
      clientEventId: messageId,
      ...(body.userMessage === undefined
        ? {}
        : { userMessage: body.userMessage }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected the chat send to queue while a run is active");
  }
  return messageId;
}

async function claimChatRunJob(runnerGroup: string, runId: string) {
  await api.heartbeatRunner(runnerGroup);
  let claim: Awaited<ReturnType<typeof api.requestClaimRunnerJob>> | undefined;
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      claim = await api.requestClaimRunnerJob(true, runId, [200, 404]);
      return claim.status;
    })(),
  ).resolves.toBe(200);
  if (!claim || claim.status !== 200) {
    throw new Error("Expected the chat run to be claimable");
  }
  return claim.body;
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
  const claim = await claimChatRunJob(runnerGroup, runId);
  return { authorization: `Bearer ${claim.sandboxToken}` };
}

function cliAgentSessionIdForChatRun(runId: string): string {
  return `bdd-cli-${runId}`;
}

const waitForThreadMessages = readThreadMessagesAfterBackgroundWork.bind(
  null,
  chat,
);

function chatRunCheckpoint(runId: string): {
  readonly cliAgentType: "claude-code";
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistoryHash: string;
} {
  const historyHash = createHash("sha256")
    .update(`bdd chat session history ${runId}`)
    .digest("hex");
  return {
    cliAgentType: "claude-code",
    cliAgentSessionId: cliAgentSessionIdForChatRun(runId),
    cliAgentSessionHistoryHash: historyHash,
  };
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  const { lastEventSequence } = options;
  const acknowledgedOutputEvents =
    lastEventSequence === undefined
      ? stagedOutputEvents
      : stagedOutputEvents.filter((event) => {
          return event.sequenceNumber <= lastEventSequence;
        });
  if (acknowledgedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId, events: acknowledgedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: chatRunCheckpoint(runId),
      ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function failChatRun(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  error: string,
  failureReason?: RunFailureReasonToken,
): Promise<void> {
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 1,
      error,
      ...(failureReason === undefined ? {} : { failureReason }),
    },
    sandboxHeaders,
    [200],
  );
}

function assistantMessages(messages: readonly ChatEvent[]): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

function userMessages(messages: readonly ChatEvent[]): UserMessage[] {
  return messages.filter(isUserMessage);
}

function isUserMessage(message: ChatEvent): message is UserMessage {
  switch (message.eventType) {
    case "input.prompt":
    case "input.automation":
    case "input.rejected":
    case "control.interrupt":
    case "control.revoke": {
      return true;
    }
    default: {
      return false;
    }
  }
}

describe("CHAT-02: isolated Auto cooldown callbacks", () => {
  it("terminalizes a queued Web message with neutral copy when every built-in route is unavailable", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    onTestFinished(async () => {
      await createBddApi(context).deleteAgent(actor, agentId);
      await flushWaitUntilForTest();
    });
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    // Only fixed Auto has foreground platform authority. Use owned key/cooldown
    // fixtures; a cloned catalog model must never become an executable route.
    const model = "okou-1.0";
    await seedBuiltInModelCandidateKeys(context, model);

    const anchor = await startChatRun(actor, {
      agentId,
      prompt: "finish before queued built-in model admission",
    });
    const ownedAnchor: {
      headers?: { readonly authorization: string };
      finished: boolean;
    } = { finished: false };
    async function cleanupAnchor(): Promise<void> {
      if (ownedAnchor.finished) {
        return;
      }
      const cleanupRuns = createRunsApi(context);
      cleanupRuns.acceptTelemetryIngest();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const current = await cleanupRuns.readRun(actor, anchor.runId);
      if (current.status === "pending" || current.status === "running") {
        await cleanupRuns.requestCancelRun(actor, anchor.runId, [200]);
      }
      if (
        ownedAnchor.headers &&
        (current.status === "pending" ||
          current.status === "running" ||
          current.status === "cancelled")
      ) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          {
            runId: anchor.runId,
            exitCode: 1,
            error: "Cancelled queued admission anchor",
          },
          ownedAnchor.headers,
          [200],
        );
      }
      await flushWaitUntilForTest();
      ownedAnchor.finished = true;
    }
    onTestFinished(cleanupAnchor);
    const anchorHeaders = await claimChatRun(runnerGroup, anchor.runId);
    ownedAnchor.headers = anchorHeaders;
    await api.updateUserModelPreference(actor, model);
    // The queued input keeps the model selected when it is enqueued.
    await chat.updateThreadModelSelection(actor, anchor.threadId, model);
    const queuedPrompt = "reject this queued message without a built-in key";
    const queuedEventId = await queueChatEvent(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: queuedPrompt,
    });
    chatCallbacks.mockChatOutputEvents([]);
    // Provider failures cool down every Built-in candidate of the model.
    await coolDownBuiltInRoutesThroughReports(context, {
      actor,
      agentId,
      runnerGroup,
      model,
      routes: AUTO_CANDIDATES,
      beforeCooldownCleanup: cleanupAnchor,
    });

    await completeChatRunOk(anchor.runId, anchorHeaders);
    await flushWaitUntilForTest();

    const terminal = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (events) => {
        return (
          userMessages(events).some((event) => {
            return (
              event.eventType === "input.rejected" &&
              event.revokesEventId === queuedEventId &&
              event.error === "model_provider_unavailable"
            );
          }) &&
          assistantMessages(events).some((event) => {
            return (
              event.eventType === "output.error" &&
              event.error === "model_provider_unavailable"
            );
          })
        );
      },
    );
    const rejected = userMessages(terminal.events).find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === queuedEventId
      );
    });
    if (rejected?.eventType !== "input.rejected") {
      throw new Error("Expected the queued Web message to be rejected");
    }
    expect(rejected.error).toBe("model_provider_unavailable");
    const errors = assistantMessages(terminal.events).filter((event) => {
      return (
        event.eventType === "output.error" &&
        event.error === "model_provider_unavailable"
      );
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.content).toBe(
      "Oops, something went wrong. Please try again later.",
    );
    const reads = createRunReadsApi(context);
    const pending = await reads.requestListLogs(
      actor,
      { status: "pending", limit: 20 },
      [200],
    );
    const running = await reads.requestListLogs(
      actor,
      { status: "running", limit: 20 },
      [200],
    );
    const active = [...pending.body.data, ...running.body.data]
      .sort((left, right) => {
        return right.createdAt.localeCompare(left.createdAt);
      })
      .slice(0, 20);
    expect(
      active.filter((run) => {
        return run.prompt === queuedPrompt;
      }),
    ).toHaveLength(0);
  }, 90_000);

  it("retains built-in billing reports and route cooldown after a public unavailable failure", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const selectedModel = "okou-1.0";
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const cleanupRoute = await resolveBuiltInModelRouteFixture(
      context,
      selectedModel,
    );
    if (!cleanupRoute) {
      throw new Error("Expected a seeded built-in route for cleanup");
    }
    registerBuiltInCandidateCooldownCleanup(
      context,
      selectedModel,
      cleanupRoute,
    );
    await api.updateUserModelPreference(actor, selectedModel);
    const first = await startChatRun(actor, {
      agentId,
      prompt: "first built-in run",
      selectedModel,
    });
    const headers = await claimChatRun(runnerGroup, first.runId);
    const reads = createRunReadsApi(context);
    const before = await reads.requestReadLogById(actor, first.runId, [200]);
    await failChatRun(
      first.runId,
      headers,
      "Credit balance is too low",
      "provider_insufficient_credits",
    );
    await flushWaitUntilForTest();
    await expect(
      api.reportRunnerModelProviderFailure(first.runId, {
        failureKind: "billing",
      }),
    ).resolves.toStrictEqual({ outcome: "recorded" });
    await expect(api.readRun(actor, first.runId)).resolves.toMatchObject({
      status: "failed",
      error: "The current model is unavailable.",
    });

    expect(before.body).toMatchObject({
      modelRuntimeProvider: "openrouter-codex",
      modelRuntimeModel: "@preset/okou-1-0",
    });
    const clientEventId = randomUUID();
    const second = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "another built-in run",
        model: selectedModel,
        clientEventId,
      },
      [201],
    );
    if (second.status !== 201) {
      throw new Error(
        "Expected the input acknowledgement before queue rejection",
      );
    }
    await flushWaitUntilForTest();
    const events = await chat.listThreadEvents(actor, second.body.threadId);
    expect(userMessages(events.events)).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
      }),
    );
    expect(
      userMessages(events.events).some((event) => {
        return event.runId !== undefined;
      }),
    ).toBeFalsy();
  });
});
