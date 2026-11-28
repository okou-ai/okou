import { randomUUID } from "node:crypto";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { describe, expect, it } from "vitest";
import { holdDownloadSigning } from "./helpers/hold-download-signing";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";

const context = testContext();
const api = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

async function initializedPredecessor() {
  const owned = await publicChatActor(context);
  const first = await owned.run(async () => {
    const run = await api.createThreadRun(owned.actor, {
      prompt: "establish the predecessor's native context",
      model: "claude-fable-5-1",
    });
    const execution = await owned.executionInput(run.runId);
    const headers = { authorization: `Bearer ${execution.sandboxToken}` };
    await completePublicClaudeRun(
      context,
      run,
      headers,
      "predecessor complete",
    );
    return { ...run, headers };
  });
  return { owned, first };
}

describe("Runner first-start Thread binding", () => {
  it("preserves native context when cancellation wins during execution preparation", async () => {
    const { owned, first } = await initializedPredecessor();
    await owned.run(async () => {
      await createBddApi(context).updatePersonalInstructions(
        owned.actor,
        `Continuation ${randomUUID()}`,
      );
      const signing = holdDownloadSigning(context);
      const chat = createChatFilesBddApi(context);
      const clientEventId = randomUUID();
      await chat.requestSendEvent(
        owned.actor,
        {
          threadId: first.threadId,
          clientEventId,
          prompt: "Cancel while execution content URLs are being signed",
        },
        [201],
      );
      await signing.waitForPending();
      const page = await chat.listThreadEvents(owned.actor, first.threadId);
      const pending = page.events.find((event) => {
        return event.revokesEventId === clientEventId;
      });
      if (!pending?.runId) {
        throw new Error("Expected a durable pending Run");
      }
      await expect(
        api.readRun(owned.actor, pending.runId),
      ).resolves.toMatchObject({ status: "pending" });
      await api.requestCancelRun(owned.actor, pending.runId, [200]);
      signing.release();
      await flushWaitUntilForTest();
      expect(api.receivedDispatches(owned.runnerGroup)).not.toContainEqual(
        expect.objectContaining({
          executionContext: expect.objectContaining({ runId: pending.runId }),
        }),
      );
      const cancelled = await api.readRun(owned.actor, pending.runId);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.startedAt).toBeUndefined();
      expect(
        (await api.readRunQueue(owned.actor)).body.concurrency.active,
      ).toBe(0);
      await expect(
        chat.readThread(owned.actor, first.threadId),
      ).resolves.toMatchObject({
        cancellationRecoveryPending: false,
      });
      const next = await api.createThreadRun(owned.actor, {
        threadId: first.threadId,
        prompt: "Continue after preparing input was cancelled",
      });
      const input = await owned.executionInput(next.runId);
      expect(input.sessionContinuation).toMatchObject({
        continueNative: true,
        expectedSourceRunId: first.runId,
      });
    });
  });

  it("preserves the preceding native context when a waiting input is recalled", async () => {
    const { owned, first } = await initializedPredecessor();
    await owned.run(async () => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      const blocker = await api.createThreadRun(owned.actor, {
        prompt: "Occupy capacity on another Thread",
      });
      const chat = createChatFilesBddApi(context);
      const clientEventId = randomUUID();
      await chat.requestSendEvent(
        owned.actor,
        {
          threadId: first.threadId,
          clientEventId,
          prompt: "Recall this waiting input before execution",
        },
        [201],
      );
      await chat.requestSendEvent(
        owned.actor,
        {
          threadId: first.threadId,
          clientEventId: randomUUID(),
          revokesEventId: clientEventId,
        },
        [201],
      );
      const input = await owned.executionInput(blocker.runId);
      await completePublicClaudeRun(
        context,
        blocker,
        { authorization: `Bearer ${input.sandboxToken}` },
        "Capacity released",
      );
      const next = await api.createThreadRun(owned.actor, {
        threadId: first.threadId,
        prompt: "Continue after recalling the waiting input",
      });
      const execution = await owned.executionInput(next.runId);
      expect(execution.sessionContinuation).toMatchObject({
        continueNative: true,
        expectedSourceRunId: first.runId,
      });
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "recovers Chat after a started Run is %s before initialization despite a late predecessor event",
    async (status) => {
      const { owned, first } = await initializedPredecessor();
      await owned.run(async () => {
        const second = await api.createThreadRun(owned.actor, {
          threadId: first.threadId,
          prompt: "start without publishing a native session",
        });
        const execution = await owned.executionInput(second.runId);
        expect(execution.sessionContinuation).toMatchObject({
          continueNative: true,
          expectedSourceRunId: first.runId,
        });
        await webhooks.requestAgentEvents(
          {
            runId: first.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: first.threadId,
                sequenceNumber: 3,
              },
            ],
          },
          first.headers,
          [200],
        );
        await flushWaitUntilForTest();
        if (status === "cancelled") {
          await api.requestCancelRun(owned.actor, second.runId, [200]);
        }
        await webhooks.requestAgentComplete(
          {
            runId: second.runId,
            exitCode: 1,
            error: "Stopped before native initialization",
          },
          { authorization: `Bearer ${execution.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        await expect(
          api.readRun(owned.actor, second.runId),
        ).resolves.toMatchObject({ status, startedAt: expect.any(String) });
        const next = await api.createThreadRun(owned.actor, {
          threadId: first.threadId,
          prompt: "recover the Thread without skipping the last executed Run",
        });
        const nextExecution = await owned.executionInput(next.runId);
        expect(nextExecution.sessionContinuation).toMatchObject({
          continueNative: false,
          expectedSourceRunId: null,
          recoveryPrompt: expect.stringContaining(
            "okou chat messages --output-dir /tmp/okou-chat-history",
          ),
        });
      });
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "retains initialized native context after a %s outcome",
    async (status) => {
      const { owned, first } = await initializedPredecessor();
      await owned.run(async () => {
        const second = await api.createThreadRun(owned.actor, {
          threadId: first.threadId,
          prompt: "initialize exactly one accepted execution",
        });
        const execution = await owned.executionInput(second.runId);
        expect(execution.sessionContinuation).toMatchObject({
          continueNative: true,
          expectedSourceRunId: first.runId,
        });
        const headers = { authorization: `Bearer ${execution.sandboxToken}` };
        const sessionId = randomUUID();
        await webhooks.requestAgentEvents(
          {
            runId: second.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: sessionId,
                sequenceNumber: 0,
              },
            ],
          },
          headers,
          [200],
        );
        await flushWaitUntilForTest();
        if (status === "cancelled") {
          await api.requestCancelRun(owned.actor, second.runId, [200]);
        }
        await webhooks.requestAgentComplete(
          {
            runId: second.runId,
            exitCode: 1,
            error: "Stopped after native initialization",
          },
          headers,
          [200],
        );
        await flushWaitUntilForTest();
        const next = await api.createThreadRun(owned.actor, {
          threadId: first.threadId,
          prompt: "resume the confirmed session after Runner settlement",
        });
        const nextExecution = await owned.executionInput(next.runId);
        expect(nextExecution.sessionContinuation).toMatchObject({
          continueNative: true,
          expectedSourceRunId: second.runId,
        });
      });
    },
  );
});
