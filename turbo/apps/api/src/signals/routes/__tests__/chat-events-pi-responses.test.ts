import { randomUUID } from "node:crypto";
import { publicChatActor } from "./helpers/public-chat-actor";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { describe, expect, it } from "vitest";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
} from "../../../lib/secret-kms-client";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";

import { chatEventDisplayText } from "./helpers/chat-event";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

import {
  createChatEventsFixture,
  userMessages,
  eventBackedContents,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  mockPiObjectStore,
  completeSandboxFirstPiRun,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function configureResponsesWithOwnedRuns(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly selectedModel: "gpt-6-luna";
}): Promise<{
  /** The normally connected personal model selection. */
  readonly model: "gpt-6-luna";
  /** The run model that executes the selection. */
  readonly runModel: string;
  readonly run: ReturnType<typeof createFixtureOperationOwner>["run"];
  readonly sendChatRun: typeof sendChatRun;
  readonly claimChatRun: typeof claimChatRun;
  readonly cancelChatRun: typeof cancelChatRun;
}> {
  const model = args.selectedModel;

  function captureExternalState() {
    const storage = context.mocks.s3.send.getMockImplementation();
    const signedUrl = context.mocks.s3.getSignedUrl.getMockImplementation();
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const kms = getSecretKmsClient();
    return () => {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      mockOptionalEnv("SECRETS_KMS_KEY_ID", kmsKey);
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", args.runnerGroup);
      setSecretKmsClientForTests(kms);
      if (storage) {
        context.mocks.s3.send.mockImplementation(storage);
      }
      if (signedUrl) {
        context.mocks.s3.getSignedUrl.mockImplementation(signedUrl);
      }
    };
  }

  let restoreAcceptedState = captureExternalState();
  let previousCleanupRunnerGroup: string | undefined;

  const owned = new Map<
    string,
    {
      readonly actor: ApiTestUser;
      readonly restoreExternalState: () => void;
      sandboxToken?: string;
      finished: boolean;
    }
  >();

  async function cleanupOwnedRuns(): Promise<void> {
    const cleanupRuns = createRunsApi(context);
    const cleanupWebhooks = createWebhookCallbackApi(context);
    for (const [runId, run] of owned) {
      if (run.finished) {
        continue;
      }
      const current = await cleanupRuns.readRun(run.actor, runId);
      if (
        current.status === "pending" ||
        current.status === "running" ||
        current.status === "cancelled"
      ) {
        run.restoreExternalState();
        cleanupRuns.acceptTelemetryIngest();
        context.mocks.ably.publish.mockResolvedValue(undefined);
        if (current.status !== "cancelled") {
          await cleanupRuns.requestCancelRun(run.actor, runId, [200]);
        }
        if (run.sandboxToken) {
          await cleanupWebhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Cancelled OpenRouter test Run" },
            { authorization: `Bearer ${run.sandboxToken}` },
            [200],
            undefined,
          );
        }
      }
      await flushWaitUntilForTest();
      run.finished = true;
    }
  }

  // These selected callbacks own every main Run before its first claim. This
  // hook and the producer hook both finish Runs before releasing model state.
  const operations = createFixtureOperationOwner(
    async () => {
      const result = await settleIncludingAbort(cleanupOwnedRuns);
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousCleanupRunnerGroup);
      if (!result.ok) {
        throw result.error;
      }
    },
    {
      beforeDrain() {
        previousCleanupRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
        restoreAcceptedState();
      },
    },
  );

  function runOwned<T>(operation: () => Promise<T>): Promise<T> {
    restoreAcceptedState = captureExternalState();
    return operations.run(operation);
  }

  async function sendOwnedRun(...parameters: Parameters<typeof sendChatRun>) {
    const restoreExternalState = captureExternalState();
    const run = await sendChatRun(...parameters);
    owned.set(run.runId, {
      actor: parameters[0],
      finished: false,
      restoreExternalState,
    });
    return run;
  }

  async function claimOwnedRun(...parameters: Parameters<typeof claimChatRun>) {
    const claim = await claimChatRun(...parameters);
    const run = owned.get(parameters[1]);
    if (!run) {
      throw new Error("Expected to own the claimed OpenRouter test Run");
    }
    run.sandboxToken = claim.claim.sandboxToken;
    return claim;
  }

  async function cancelOwnedRun(
    ...parameters: Parameters<typeof cancelChatRun>
  ): Promise<void> {
    const run = owned.get(parameters[1]);
    if (!run?.sandboxToken) {
      throw new Error("Expected a claimed OpenRouter test Run to cancel");
    }
    await cancelChatRun(
      parameters[0],
      parameters[1],
      parameters[2] ?? { authorization: `Bearer ${run.sandboxToken}` },
    );
    run.finished = true;
  }

  await runOwned(async () => {
    await configureSubscriptionPiModel(args.actor, {}, model);
  });

  return {
    model,
    runModel: model,
    run: runOwned,
    sendChatRun: (...parameters) => {
      return runOwned(() => {
        return sendOwnedRun(...parameters);
      });
    },
    claimChatRun: (...parameters) => {
      return runOwned(() => {
        return claimOwnedRun(...parameters);
      });
    },
    cancelChatRun: (...parameters) => {
      return runOwned(() => {
        return cancelOwnedRun(...parameters);
      });
    },
  };
}

describe("CHAT-02: model-first routing", () => {
  it("reuses one OpenRouter Responses Pi session across standard, fast, and standard turns for gpt-6-luna", async () => {
    const selectedModel = "gpt-6-luna";
    const { actor, agentId, runnerGroup } = await publicChatActor(context);
    const {
      run: own,
      model,
      sendChatRun,
      claimChatRun,
    } = await configureResponsesWithOwnedRuns({
      actor,
      agentId,
      runnerGroup,
      selectedModel,
    });

    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const prompts = [
      "start standard Luna in the canonical Pi session",
      "continue fast Luna in the same Pi session",
      "return to standard Luna in the same Pi session",
    ] as const;
    const answers = [
      "first standard Luna answer",
      "fast Luna answer",
      "returned standard Luna answer",
    ] as const;

    const first = await sendChatRun(actor, {
      agentId,
      prompt: prompts[0],
      model,
    });
    await flushWaitUntilForTest();
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.piModelConfig).toMatchObject({
      model: selectedModel,
    });
    expect(firstClaim.claim.piModelConfig).not.toHaveProperty("serviceTier");
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: answers[0],
        historyObjects,
        claim: firstClaim,
        prompt: prompts[0],
        run: first,
        responsesModel: { provider: "openai-codex", model: selectedModel },
      });
    });
    const firstSessionId = await readCompletedRunSessionId(
      context,
      actor,
      first.runId,
    );

    const fast = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: prompts[1],
      model,
      runOptions: { codexServiceTier: "fast" },
    });
    await flushWaitUntilForTest();
    const fastClaim = await claimChatRun(runnerGroup, fast.runId);
    expect(fastClaim.claim.piModelConfig).toMatchObject({
      model: selectedModel,
      serviceTier: "fast",
    });
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: answers[1],
        historyObjects,
        claim: fastClaim,
        prompt: prompts[1],
        run: fast,
        responsesModel: { provider: "openai-codex", model: selectedModel },
      });
    });
    await expect(
      readCompletedRunSessionId(context, actor, fast.runId),
    ).resolves.toBe(firstSessionId);

    await own(async () => {
      return await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        model,
        {
          codexServiceTier: null,
        },
      );
    });
    const returned = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: prompts[2],
      model,
    });
    await flushWaitUntilForTest();
    const returnedClaim = await claimChatRun(runnerGroup, returned.runId);
    expect(returnedClaim.claim.piModelConfig).toMatchObject({
      model: selectedModel,
    });
    expect(returnedClaim.claim.piModelConfig).not.toHaveProperty("serviceTier");
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: answers[2],
        historyObjects,
        claim: returnedClaim,
        prompt: prompts[2],
        run: returned,
        responsesModel: { provider: "openai-codex", model: selectedModel },
      });
    });
    await expect(
      readCompletedRunSessionId(context, actor, returned.runId),
    ).resolves.toBe(firstSessionId);

    for (const run of [first, fast, returned]) {
      const claim = await own(() => {
        return api.requestClaimRunnerJob(true, run.runId, [404]);
      });
      expect(claim.status).toBe(404);
    }
    for (const runId of [fast.runId, returned.runId]) {
      const run = await api.readRun(actor, runId);
      const appendSystemPrompt = run.appendSystemPrompt ?? "";
      for (const turn of [...prompts, ...answers]) {
        expect(appendSystemPrompt).not.toContain(turn);
      }
    }

    await expectThreadModelCredits(context, actor, first.threadId, 0);
    await expectThreadModelCredits(context, actor, fast.threadId, 0);
    await expectThreadModelCredits(context, actor, returned.threadId, 0);

    const visibleTurns = [
      { runId: first.runId, prompt: prompts[0], answer: answers[0] },
      { runId: fast.runId, prompt: prompts[1], answer: answers[1] },
      { runId: returned.runId, prompt: prompts[2], answer: answers[2] },
    ];
    const finalEvents = await waitForThreadMessages(
      actor,
      first.threadId,
      (events) => {
        return eventBackedContents(events, returned.runId).some((event) => {
          return event.content === answers[2];
        });
      },
    );
    const runIds = new Set(
      visibleTurns.map((turn) => {
        return turn.runId;
      }),
    );
    expect(
      finalEvents.events
        .filter((event) => {
          return (
            event.runId !== undefined &&
            event.runId !== null &&
            runIds.has(event.runId) &&
            (event.eventType === "input.prompt" ||
              event.eventType === "output.message")
          );
        })
        .map((event) => {
          return {
            runId: event.runId,
            eventType: event.eventType,
            content: chatEventDisplayText(event),
          };
        }),
    ).toStrictEqual(
      visibleTurns.flatMap((turn) => {
        return [
          {
            runId: turn.runId,
            eventType: "input.prompt",
            content: turn.prompt,
          },
          {
            runId: turn.runId,
            eventType: "output.message",
            content: turn.answer,
          },
        ];
      }),
    );
    const sessionBlobs = [...historyObjects.entries()].filter(([key]) => {
      return key.includes("/blobs/");
    });
    expect(sessionBlobs).toStrictEqual([]);
  }, 90_000);

  it("promotes queued fast gpt-6-luna to a priority Pi Sandbox run", async () => {
    const selectedModel = "gpt-6-luna";
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
      requestSendEvent,
    } = await publicChatActor(context);
    // The anchor must stay on the native Runner while the queued target
    // proves Pi promotion; Sonnet 5 would itself run through Pi.
    await own(async () => {
      return await api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold the thread before queued fast Luna",
      model: "claude-fable-5-1",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, selectedModel);
    });

    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const prompt = "promote queued fast Luna through the callback";
    const answer = "queued fast Luna Sandbox answer";

    const queuedId = randomUUID();
    const queued = await requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientEventId: queuedId,
        model: selectedModel,
        runOptions: { codexServiceTier: "fast" },
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected queued fast Luna to enter the chat queue");
    }

    chatCallbacks.mockChatOutputEvents([]);
    await own(async () => {
      return await completeChatRunOk(
        anchor.runId,
        anchorClaim.sandboxHeaders,
        {},
      );
    });
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return (
            event.revokesEventId === queuedId && typeof event.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((event) => {
      return event.revokesEventId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected queued fast Luna to create a run");
    }
    const promotedRunId = promoted.runId;
    await flushWaitUntilForTest();

    const promotedClaim = await claimChatRun(runnerGroup, promotedRunId);
    expect(promotedClaim.claim.cliAgentType).toBe("pi");
    expect(promotedClaim.claim.piModelConfig).toMatchObject({
      model: selectedModel,
      serviceTier: "fast",
    });
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer,
        historyObjects,
        claim: promotedClaim,
        prompt,
        run: { runId: promotedRunId, threadId: anchor.threadId },
        responsesModel: { provider: "openai-codex", model: selectedModel },
      });
    });
    const finalEvents = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (events) => {
        return eventBackedContents(events, promotedRunId).some((event) => {
          return event.content === answer;
        });
      },
    );
    expect(
      eventBackedContents(finalEvents.events, promotedRunId).filter((event) => {
        return event.content === answer;
      }),
    ).toHaveLength(1);
  }, 90_000);
});
