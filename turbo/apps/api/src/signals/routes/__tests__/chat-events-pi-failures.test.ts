import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext, type TestContext } from "../../../__tests__/test-context";
import { TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
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
  };
}

describe("chat-events-pi-failures", () => {
  const context = testContext();

  it(
    "chat-events-pi-failures-002 preserves native subscription continuity and active steering input without history upload",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const chatActor = await createPiCodexChatActor(context);
      const { actor, fixture } = chatActor;
      const historyObjects = fixture.mockPiObjectStore();

      const firstPrompt = "Draft the initial migration plan";
      const firstAnswer =
        "Initial migration plan token-7f4e91c2 ready for review.";
      const run1 = await chatActor.sendChatRun(actor, {
        model: "gpt-6-luna",
        prompt: firstPrompt,
      });
      const exec1 = await chatActor.runExecution(run1.runId);
      await chatActor.run(async () => {
        await fixture.webhooks.requestAgentEvents(
          {
            runId: run1.runId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 1,
                message: { content: [{ type: "text", text: firstAnswer }] },
              },
              { type: "result", sequenceNumber: 2, result: firstAnswer },
            ],
          },
          exec1.sandboxHeaders,
          [200],
        );
        await fixture.webhooks.requestAgentComplete(
          {
            runId: run1.runId,
            exitCode: 0,
            lastEventSequence: 2,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: run1.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
          exec1.sandboxHeaders,
          [200],
        );
        await flushWaitUntilForTest();
      });

      const secondPrompt = "Refine the rollback verification steps";
      const run2 = await chatActor.sendChatRun(actor, {
        threadId: run1.threadId,
        model: "gpt-6-luna",
        prompt: secondPrompt,
      });
      const exec2 = await chatActor.runExecution(run2.runId);

      expect(exec2.execution.prompt).toBe(secondPrompt);
      expect(exec2.execution.cliAgentType).toBe("pi");
      expect(exec2.execution.piSessionId).toBe(run1.threadId);
      expect(exec2.execution.nativeContinuation).toMatchObject({
        sessionId: run1.threadId,
        generationRunId: run1.runId,
      });
      expect(exec2.execution.appendSystemPrompt ?? "").not.toContain(
        firstAnswer,
      );
      expect(historyObjects.size).toBe(0);

      const steeringEventId = randomUUID();
      const steeringPrompt = "Also include the staging smoke check";
      await chatActor.run(() => {
        return fixture.chat.requestSendEvent(
          actor,
          {
            threadId: run1.threadId,
            prompt: steeringPrompt,
            clientEventId: steeringEventId,
          },
          [201],
        );
      });
      await flushWaitUntilForTest();

      const firstPoll = await chatActor.run(() => {
        return fixture.api.nextSteerableInput(
          exec2.execution.sandboxToken,
          run2.runId,
        );
      });
      const secondPoll = await chatActor.run(() => {
        return fixture.api.nextSteerableInput(
          exec2.execution.sandboxToken,
          run2.runId,
        );
      });
      expect(firstPoll).toStrictEqual({
        input: {
          eventId: steeringEventId,
          prompt: steeringPrompt,
        },
      });
      expect(secondPoll).toStrictEqual({
        input: {
          eventId: steeringEventId,
          prompt: steeringPrompt,
        },
      });

      const steered = await chatActor.run(() => {
        return fixture.api.declareSteeredInput(
          exec2.execution.sandboxToken,
          run2.runId,
          steeringEventId,
        );
      });
      expect(steered).toStrictEqual({ outcome: "steered" });
      await flushWaitUntilForTest();

      const [threadEvents, modelCredits] = await Promise.all([
        fixture.chat.listThreadEvents(actor, run1.threadId),
        readThreadModelCredits(context, actor, run1.threadId),
      ]);
      const revokingSteering = userMessages(threadEvents.events).filter(
        (event) => {
          return event.revokesEventId === steeringEventId;
        },
      );
      expect(revokingSteering).toHaveLength(1);
      expect(revokingSteering[0]).toMatchObject({
        eventType: "input.prompt",
        runId: run2.runId,
        revokesEventId: steeringEventId,
      });
      expect(chatEventDisplayText(revokingSteering[0]!)).toBe(steeringPrompt);

      const activeRunTerminalEvents = threadEvents.events.filter((event) => {
        return (
          event.runId === run2.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      });
      expect(activeRunTerminalEvents).toStrictEqual([]);
      expect(historyObjects.size).toBe(0);
      expect(modelCredits).toBe(0);
    },
  );
});
