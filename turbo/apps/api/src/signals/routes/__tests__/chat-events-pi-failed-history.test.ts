import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { prepareRunnerSessionHistory } from "./helpers/runner-session-history";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const { api, webhooks, configureSubscriptionPiModel, cancelChatRun } =
  createChatEventsFixture(context);

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
      mockSecretKmsHttp();
      const {
        actor,
        agentId,
        runnerGroup,
        run: own,
        sendChatRun,
        claimChatRun,
      } = await publicChatActor(context);
      const model = "gpt-6-luna";
      await own(() => {
        return configureSubscriptionPiModel(actor, {}, model);
      });
      const first = await sendChatRun(actor, {
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
      const completedHash = await own(() => {
        return prepareRunnerSessionHistory(
          context,
          first.runId,
          firstClaim.sandboxHeaders,
          session.toJsonl(),
        );
      });
      await own(() => {
        return webhooks.requestAgentComplete(
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
      });
      await own(flushWaitUntilForTest);
      const completedRun = await own(() => {
        return api.readRun(actor, first.runId);
      });
      expect(completedRun.status).toBe("completed");
      expect(completedRun.result?.conversationId).toStrictEqual(
        expect.any(String),
      );

      const failed = await sendChatRun(actor, {
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
      const failedHash = await own(() => {
        return prepareRunnerSessionHistory(
          context,
          failed.runId,
          failedClaim.sandboxHeaders,
          session.toJsonl(),
        );
      });
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
      const response = await own(() => {
        return webhooks.requestAgentComplete(
          completion,
          failedClaim.sandboxHeaders,
          [200],
        );
      });
      expect(response.body).toStrictEqual({ success: true, status: "failed" });
      await own(flushWaitUntilForTest);
      const retained = await own(() => {
        return api.readRun(actor, failed.runId);
      });
      expect(retained.status).toBe("failed");
      expect(retained.error).toBe("Codex request failed");
      expect(retained.result?.conversationId).toStrictEqual(expect.any(String));
      expect(retained.result?.conversationId).not.toBe(
        completedRun.result?.conversationId,
      );

      const retry = await own(() => {
        return webhooks.requestAgentComplete(
          completion,
          failedClaim.sandboxHeaders,
          [200],
        );
      });
      expect(retry.body).toStrictEqual(response.body);
      const retried = await own(() => {
        return api.readRun(actor, failed.runId);
      });
      expect(retried.result).toStrictEqual(retained.result);
      const next = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "resume from the completed checkpoint",
      });
      const nextClaim = await claimChatRun(runnerGroup, next.runId);
      expect(nextClaim.claim.resumeSession).toMatchObject({
        sessionId: first.threadId,
        historyRef: { kind: "blob", hash: completedHash },
      });
      await own(() => {
        return cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
      });
    },
  );
});
