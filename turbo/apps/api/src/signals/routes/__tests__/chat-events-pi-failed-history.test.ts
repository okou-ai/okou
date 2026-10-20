import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const { api, webhooks, configureSubscriptionPiModel, cancelChatRun } =
  createChatEventsFixture(context);

describe("Pi failed native continuation", () => {
  it.each(["empty", "partial"] as const)(
    "retains the actual native identity after a failed %s answer",
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
      await own(() => {
        return webhooks.requestAgentComplete(
          {
            runId: first.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: first.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
          firstClaim.sandboxHeaders,
          [200],
        );
      });
      await own(flushWaitUntilForTest);
      const failed = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue the task",
        model,
      });
      const failedClaim = await claimChatRun(runnerGroup, failed.runId);
      const events = [
        {
          type: "system" as const,
          subtype: "init",
          session_id: first.threadId,
          sequenceNumber: 0,
        },
        ...(content === "partial"
          ? [
              {
                type: "assistant" as const,
                sequenceNumber: 1,
                message: {
                  content: [{ type: "text", text: "partial failed answer" }],
                },
              },
            ]
          : []),
      ];
      await own(() => {
        return webhooks.requestAgentEvents(
          { runId: failed.runId, events },
          failedClaim.sandboxHeaders,
          [200],
        );
      });
      const completion = {
        runId: failed.runId,
        exitCode: 1,
        error: "Codex request failed",
        lastEventSequence: events.length - 1,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: first.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
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
      expect(retained).toMatchObject({
        status: "failed",
        error: "Codex request failed",
        result: { framework: "pi", frameworkSessionId: first.threadId },
      });
      await own(() => {
        return webhooks.requestAgentComplete(
          completion,
          failedClaim.sandboxHeaders,
          [200],
        );
      });
      expect(
        (
          await own(() => {
            return api.readRun(actor, failed.runId);
          })
        ).result,
      ).toStrictEqual(retained.result);
      const next = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with the retained native context",
        model,
      });
      const nextClaim = await claimChatRun(runnerGroup, next.runId);

      expect(nextClaim.claim.nativeContinuation).toMatchObject({
        sessionId: first.threadId,
        generationRunId: failed.runId,
      });
      await own(() => {
        return cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
      });
    },
  );
});
