import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

function publishedTopics(): string[] {
  return context.mocks.ably.publish.mock.calls.map(([topic]) => {
    return String(topic);
  });
}

function indicatorSignalCount(): number {
  return publishedTopics().filter((topic) => {
    return topic === "chatIndicatorsChanged";
  }).length;
}

describe("chat indicator realtime signal", () => {
  it("signals a Run start and its terminal marker but not its output", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      context.mocks.ably.publish.mockClear();
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "summarize the release checklist",
        model: "claude-fable-5-1",
      });
      expect(indicatorSignalCount()).toBe(1);

      const claim = await owned.claimRunnerRun(run.runId);
      const headers = { authorization: `Bearer ${claim.sandboxToken}` };
      context.mocks.ably.publish.mockClear();
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: run.threadId,
              sequenceNumber: 0,
            },
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: [{ type: "text", text: "Checklist ready" }] },
            },
            { type: "result", sequenceNumber: 2, result: "Checklist ready" },
          ],
        },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      // Output reaches open threads through message notifications only.
      expect(publishedTopics()).toContain(
        `chatThreadMessageCreated:${run.threadId}`,
      );
      expect(indicatorSignalCount()).toBe(0);

      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          lastEventSequence: 2,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        headers,
        [200],
      );
      await flushWaitUntilForTest();
      expect(indicatorSignalCount()).toBe(1);
      await expect(api.readRun(owned.actor, run.runId)).resolves.toMatchObject({
        status: "completed",
      });
    });
  });

  it("signals a cancelled Run's terminal marker", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "cancel this before a Runner starts it",
      });
      context.mocks.ably.publish.mockClear();
      await api.requestCancelRun(owned.actor, run.runId, [200]);
      await flushWaitUntilForTest();
      expect(indicatorSignalCount()).toBe(1);
      await expect(api.readRun(owned.actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
    });
  });
});
