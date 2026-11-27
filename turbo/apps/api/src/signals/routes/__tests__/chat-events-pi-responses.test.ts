import { describe, expect, it, onTestFinished } from "vitest";
import { testContext, type TestContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventDisplayText } from "./helpers/chat-event";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { readThreadModelCredits } from "./helpers/public-thread-usage";

async function createPiCodexChatActor(context: TestContext) {
  const fixture = createChatEventsFixture(context);
  const actor = fixture.bdd.user();
  let accepted = captureConnectorExternalState(context);
  let previous: (() => void) | undefined;
  onTestFinished(() => {
    previous?.();
  });
  const owner = publicRunOwner(context, actor, {
    continueAcceptedOperations: true,
    restoreEnvironment: () => {
      previous ??= captureConnectorExternalState(context);
      accepted();
    },
  });
  function run<T>(operation: () => Promise<T>) {
    return owner.run(() => {
      const pending = settleIncludingAbort(operation);
      accepted = captureConnectorExternalState(context);
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
  const runnerGroupPromise = fixture.api.configureRunnerGroup();
  await Promise.all([
    runnerGroupPromise,
    run(() => {
      return fixture.api.grantProEntitlement(actor);
    }),
  ]);
  await run(() => {
    return fixture.connectSubscriptionPiModel(actor);
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
    async completePiTurn(
      target: { readonly runId: string; readonly threadId: string },
      sandboxHeaders: { readonly authorization: string },
      answer: string,
    ): Promise<void> {
      await run(async () => {
        await fixture.webhooks.requestAgentEvents(
          {
            runId: target.runId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 1,
                message: { content: [{ type: "text", text: answer }] },
              },
              { type: "result", sequenceNumber: 2, result: answer },
            ],
          },
          sandboxHeaders,
          [200],
        );
        await fixture.webhooks.requestAgentComplete(
          {
            runId: target.runId,
            exitCode: 0,
            lastEventSequence: 2,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: target.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
          sandboxHeaders,
          [200],
        );
        await flushWaitUntilForTest();
      });
    },
  };
}

function visibleConversationPairs(
  events: Awaited<
    ReturnType<
      ReturnType<typeof createChatEventsFixture>["chat"]["listThreadEvents"]
    >
  >["events"],
) {
  const revokedIds = new Set(
    events.flatMap((event) => {
      return event.revokesEventId ? [event.revokesEventId] : [];
    }),
  );
  return events
    .filter((event) => {
      return (
        !revokedIds.has(event.id) &&
        (event.eventType === "input.prompt" ||
          event.eventType === "output.message")
      );
    })
    .map((event) => {
      return {
        eventType: event.eventType,
        text: chatEventDisplayText(event),
      };
    });
}

describe("chat-events-pi-responses", () => {
  const context = testContext();

  it(
    "chat-events-pi-responses-001 (1/2) reuses one Pi Responses session from a standard turn to a fast turn for gpt-6-luna",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;
      const historyObjects = fixture.mockPiObjectStore();

      const prompt1 = "Turn one standard prompt alpha-101";
      const answer1 = "Turn one standard answer alpha-102";
      const run1 = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: prompt1,
      });
      const exec1 = await chatActor.runExecution(run1.runId);
      expect(exec1.execution.cliAgentType).toBe("pi");
      expect(exec1.execution.piSessionId).toBe(run1.threadId);
      expect(exec1.execution.piModelConfig).toMatchObject({
        model: "gpt-6-luna",
        dialect: "openai-codex-responses",
      });
      expect(exec1.execution.piModelConfig).not.toHaveProperty("serviceTier");
      await chatActor.completePiTurn(run1, exec1.sandboxHeaders, answer1);

      const prompt2 = "Turn two fast prompt beta-201";
      const answer2 = "Turn two fast answer beta-202";
      const run2 = await chatActor.sendChatRun(actor, {
        threadId: run1.threadId,
        model: "gpt-6-luna",
        runOptions: { codexServiceTier: "fast" },
        prompt: prompt2,
      });
      const exec2 = await chatActor.runExecution(run2.runId);
      expect(exec2.execution.cliAgentType).toBe("pi");
      expect(exec2.execution.piSessionId).toBe(run1.threadId);
      expect(exec2.execution.piModelConfig).toMatchObject({
        model: "gpt-6-luna",
        dialect: "openai-codex-responses",
        serviceTier: "fast",
      });
      expect(exec2.execution.nativeContinuation).toMatchObject({
        sessionId: run1.threadId,
        generationRunId: run1.runId,
      });
      expect(exec2.execution.appendSystemPrompt ?? "").not.toContain(prompt1);
      expect(exec2.execution.appendSystemPrompt ?? "").not.toContain(answer1);
      await chatActor.completePiTurn(run2, exec2.sandboxHeaders, answer2);

      const [storedRun1, storedRun2, history, modelCredits] = await Promise.all(
        [
          fixture.api.readRun(actor, run1.runId),
          fixture.api.readRun(actor, run2.runId),
          fixture.chat.listThreadEvents(actor, run1.threadId),
          readThreadModelCredits(context, actor, run1.threadId),
        ],
      );
      for (const storedRun of [storedRun1, storedRun2]) {
        expect(storedRun.status).toBe("completed");
        expect(storedRun.result).toMatchObject({
          framework: "pi",
          frameworkSessionId: run1.threadId,
        });
      }
      expect(visibleConversationPairs(history.events)).toStrictEqual([
        { eventType: "input.prompt", text: prompt1 },
        { eventType: "output.message", text: answer1 },
        { eventType: "input.prompt", text: prompt2 },
        { eventType: "output.message", text: answer2 },
      ]);
      expect(historyObjects.size).toBe(0);
      expect(modelCredits).toBe(0);
    },
  );

  it(
    "chat-events-pi-responses-001 (2/2) reuses the same Pi Responses session after clearing fast service tier back to standard",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;
      const historyObjects = fixture.mockPiObjectStore();

      const prompt1 = "Fast turn prompt beta-201";
      const answer1 = "Fast turn answer beta-202";
      const run1 = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        runOptions: { codexServiceTier: "fast" },
        prompt: prompt1,
      });
      const exec1 = await chatActor.runExecution(run1.runId);
      expect(exec1.execution.cliAgentType).toBe("pi");
      expect(exec1.execution.piSessionId).toBe(run1.threadId);
      expect(exec1.execution.piModelConfig).toMatchObject({
        model: "gpt-6-luna",
        dialect: "openai-codex-responses",
        serviceTier: "fast",
      });
      await chatActor.completePiTurn(run1, exec1.sandboxHeaders, answer1);

      await chatActor.run(() => {
        return fixture.chat.updateThreadModelSelection(
          actor,
          run1.threadId,
          "gpt-6-luna",
          { codexServiceTier: null },
        );
      });

      const prompt2 = "Cleared standard turn prompt gamma-301";
      const answer2 = "Cleared standard turn answer gamma-302";
      const run2 = await chatActor.sendChatRun(actor, {
        threadId: run1.threadId,
        model: "gpt-6-luna",
        prompt: prompt2,
      });
      const exec2 = await chatActor.runExecution(run2.runId);
      expect(exec2.execution.cliAgentType).toBe("pi");
      expect(exec2.execution.piSessionId).toBe(run1.threadId);
      expect(exec2.execution.piModelConfig).toMatchObject({
        model: "gpt-6-luna",
        dialect: "openai-codex-responses",
      });
      expect(exec2.execution.piModelConfig).not.toHaveProperty("serviceTier");
      expect(exec2.execution.nativeContinuation).toMatchObject({
        sessionId: run1.threadId,
        generationRunId: run1.runId,
      });
      for (const priorText of [prompt1, answer1, prompt2, answer2]) {
        expect(exec2.execution.appendSystemPrompt ?? "").not.toContain(
          priorText,
        );
      }
      await chatActor.completePiTurn(run2, exec2.sandboxHeaders, answer2);

      const [storedRun1, storedRun2, history, modelCredits] = await Promise.all(
        [
          fixture.api.readRun(actor, run1.runId),
          fixture.api.readRun(actor, run2.runId),
          fixture.chat.listThreadEvents(actor, run1.threadId),
          readThreadModelCredits(context, actor, run1.threadId),
        ],
      );
      for (const storedRun of [storedRun1, storedRun2]) {
        expect(storedRun.status).toBe("completed");
        expect(storedRun.result).toMatchObject({
          framework: "pi",
          frameworkSessionId: run1.threadId,
        });
      }
      expect(visibleConversationPairs(history.events)).toStrictEqual([
        { eventType: "input.prompt", text: prompt1 },
        { eventType: "output.message", text: answer1 },
        { eventType: "input.prompt", text: prompt2 },
        { eventType: "output.message", text: answer2 },
      ]);
      expect(historyObjects.size).toBe(0);
      expect(modelCredits).toBe(0);
    },
  );
});
