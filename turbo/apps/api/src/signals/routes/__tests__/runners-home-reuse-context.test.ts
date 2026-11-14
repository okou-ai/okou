import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

describe("Runner claim home-reuse context", () => {
  it("distinguishes current input, earlier Runs and another thread through public claims", async () => {
    const api = createRunsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const {
      actor,
      agentId,
      run: own,
      executionInput,
    } = await publicChatActor(context);

    await own(async () => {
      await api.updateUserModelPreference(actor, "claude-fable-5-1");
      const first = await api.createThreadRun(actor, {
        agentId,
        prompt: "first home-reuse context",
      });
      const firstExecution = await executionInput(first.runId);
      // The first prompt is already attributed to this Run when claim reads it.
      expect(firstExecution).toMatchObject({ isFirstRun: true });
      await webhooks.requestAgentComplete(
        { runId: first.runId, exitCode: 0 },
        { authorization: `Bearer ${firstExecution.sandboxToken}` },
        [200],
      );

      const next = await api.createThreadRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "subsequent home-reuse context",
      });
      const nextExecution = await executionInput(next.runId);
      expect(nextExecution).toMatchObject({ isFirstRun: false });
      await webhooks.requestAgentComplete(
        { runId: next.runId, exitCode: 0 },
        { authorization: `Bearer ${nextExecution.sandboxToken}` },
        [200],
      );

      const other = await api.createThreadRun(actor, {
        agentId,
        prompt: "first context in another thread",
      });
      expect(other.threadId).not.toBe(first.threadId);
      const otherExecution = await executionInput(other.runId);
      expect(otherExecution).toMatchObject({ isFirstRun: true });
    });
  });
});
