import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { prepareRunnerSessionHistory } from "./helpers/runner-session-history";

const context = testContext();
const {
  api,
  webhooks,
  entitledChatActor,
  configureSubscriptionPiModel,
  sendChatRunAfterPick,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

function appendAssistant(
  session: MemoryPiSession,
  text: string,
  stopReason: "stop" | "error",
): void {
  session.appendMessage({
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-6-luna",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: now(),
  });
}

describe("Pi failed native history completion", () => {
  it.each(["empty", "partial"] as const)(
    "retains %s error leaves without advancing canonical continuation",
    async (content) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const model = "gpt-6-luna";
      await configureSubscriptionPiModel(actor, {}, model);
      const first = await sendChatRunAfterPick(actor, {
        agentId,
        prompt: "complete the first turn",
        model,
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.cliAgentType).toBe("pi");
      expect(firstClaim.claim.piSessionId).toBe(first.threadId);
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: first.threadId,
      });
      session.appendMessage({
        role: "user",
        content: "complete the first turn",
        timestamp: now(),
      });
      appendAssistant(session, "completed first turn", "stop");
      const completedHash = await prepareRunnerSessionHistory(
        context,
        first.runId,
        firstClaim.sandboxHeaders,
        session.toJsonl(),
      );
      await webhooks.requestAgentComplete(
        {
          runId: first.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: first.threadId,
            cliAgentSessionHistoryHash: completedHash,
          },
        },
        firstClaim.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      const completedRun = await api.readRun(actor, first.runId);
      expect(completedRun.status).toBe("completed");
      expect(completedRun.result?.conversationId).toStrictEqual(
        expect.any(String),
      );

      const failed = await sendChatRunAfterPick(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue the task",
      });
      const failedClaim = await claimChatRun(runnerGroup, failed.runId);
      session.appendMessage({
        role: "user",
        content: "continue the task",
        timestamp: now(),
      });
      appendAssistant(
        session,
        content === "empty" ? "" : "partial failed answer",
        "error",
      );
      const failedHash = await prepareRunnerSessionHistory(
        context,
        failed.runId,
        failedClaim.sandboxHeaders,
        session.toJsonl(),
      );
      const completion = {
        runId: failed.runId,
        exitCode: 1,
        error: "Codex request failed",
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: failed.threadId,
          cliAgentSessionHistoryHash: failedHash,
        },
      } as const;
      const response = await webhooks.requestAgentComplete(
        completion,
        failedClaim.sandboxHeaders,
        [200],
      );
      expect(response.body).toStrictEqual({ success: true, status: "failed" });
      await flushWaitUntilForTest();
      const retained = await api.readRun(actor, failed.runId);
      expect(retained.status).toBe("failed");
      expect(retained.error).toBe("Codex request failed");
      expect(retained.result?.conversationId).toStrictEqual(expect.any(String));
      expect(retained.result?.conversationId).not.toBe(
        completedRun.result?.conversationId,
      );

      const retry = await webhooks.requestAgentComplete(
        completion,
        failedClaim.sandboxHeaders,
        [200],
      );
      expect(retry.body).toStrictEqual(response.body);
      expect((await api.readRun(actor, failed.runId)).result).toStrictEqual(
        retained.result,
      );
      const next = await sendChatRunAfterPick(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "resume from the completed checkpoint",
      });
      const nextClaim = await claimChatRun(runnerGroup, next.runId);
      expect(nextClaim.claim.resumeSession).toMatchObject({
        sessionId: first.threadId,
        historyRef: { kind: "blob", hash: completedHash },
      });
      await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
    },
  );
});
