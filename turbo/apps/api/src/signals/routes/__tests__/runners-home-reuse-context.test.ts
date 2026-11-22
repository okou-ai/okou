import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

describe("Execution home-reuse context", () => {
  it("distinguishes current input, earlier Runs and another thread through dispatched input", async () => {
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
        prompt: "first home-reuse context",
      });
      const firstExecution = await executionInput(first.runId);
      // The first prompt is already attributed to this Run during preparation.
      expect(firstExecution).toMatchObject({ isFirstRun: true });
      await webhooks.requestAgentComplete(
        { runId: first.runId, exitCode: 0 },
        { authorization: `Bearer ${firstExecution.sandboxToken}` },
        [200],
      );

      const next = await api.createThreadRun(actor, {
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
        prompt: "first context in another thread",
      });
      expect(other.threadId).not.toBe(first.threadId);
      const otherExecution = await executionInput(other.runId);
      expect(otherExecution).toMatchObject({ isFirstRun: true });
    });
  });
});
