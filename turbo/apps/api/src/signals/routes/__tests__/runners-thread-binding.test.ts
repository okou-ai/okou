import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

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
      agentId: owned.agentId,
      prompt: "establish the predecessor's native context",
      model: "claude-fable-5-1",
    });
    const claim = await owned.claimRunnerRun(run.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
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
  it("preserves the preceding native context when a queued Run is cancelled", async () => {
    const { owned, first } = await initializedPredecessor();
    await owned.run(async () => {
      const pending = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        threadId: first.threadId,
        prompt: "cancel this input before a Runner starts it",
      });
      await api.requestCancelRun(owned.actor, pending.runId, [200]);
      await flushWaitUntilForTest();
      const cancelled = await api.readRun(owned.actor, pending.runId);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.startedAt).toBeUndefined();
      const next = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        threadId: first.threadId,
        prompt: "continue after the never-started cancellation",
      });
      const claim = await owned.claimRunnerRun(next.runId);
      expect(claim.nativeContinuation).toMatchObject({
        sessionId: first.threadId,
        generationRunId: first.runId,
      });
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "recovers Chat after a started Run is %s before initialization despite a late predecessor event",
    async (status) => {
      const { owned, first } = await initializedPredecessor();
      await owned.run(async () => {
        const second = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          threadId: first.threadId,
          prompt: "start without publishing a native session",
        });
        const claim = await owned.claimRunnerRun(second.runId);
        expect(claim.nativeContinuation).toMatchObject({
          sessionId: first.threadId,
          generationRunId: first.runId,
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
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        await expect(
          api.readRun(owned.actor, second.runId),
        ).resolves.toMatchObject({ status, startedAt: expect.any(String) });
        const next = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          threadId: first.threadId,
          prompt: "recover the Thread without skipping the last executed Run",
        });
        const nextClaim = await owned.claimRunnerRun(next.runId);
        expect(nextClaim.nativeContinuation).toMatchObject({
          sessionId: null,
          generationRunId: null,
          recoveryPrompt: expect.stringContaining(
            "okou chat messages --output-dir threads",
          ),
        });
      });
    },
  );

  it("settles a claim racing cancellation before the next Run chooses its native context", async () => {
    const { owned, first } = await initializedPredecessor();
    await owned.run(async () => {
      const second = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        threadId: first.threadId,
        prompt: "race Runner acceptance with user cancellation",
      });
      const [claim] = await Promise.all([
        api.requestClaimRunnerJob(true, second.runId, [200, 404]),
        api.requestCancelRun(owned.actor, second.runId, [200]),
      ]);
      if (claim.status === 200) {
        owned.rememberClaim(second.runId, claim.body.sandboxToken);
        await webhooks.requestAgentComplete(
          {
            runId: second.runId,
            exitCode: 1,
            error: "Runner stopped after cancellation",
          },
          { authorization: `Bearer ${claim.body.sandboxToken}` },
          [200],
        );
      }
      await flushWaitUntilForTest();
      const cancelled = await api.readRun(owned.actor, second.runId);
      expect(cancelled.status).toBe("cancelled");
      expect(Boolean(cancelled.startedAt)).toBe(claim.status === 200);
      const next = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        threadId: first.threadId,
        prompt: "continue after the racing cancellation is settled",
      });
      const nextClaim = await owned.claimRunnerRun(next.runId);
      expect(nextClaim.nativeContinuation).toMatchObject({
        sessionId: cancelled.startedAt ? null : first.threadId,
        generationRunId: cancelled.startedAt ? null : first.runId,
        recoveryPrompt: expect.stringContaining(
          "okou chat messages --output-dir threads",
        ),
      });
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "retains initialized native context after competing claims, replay and a %s outcome",
    async (status) => {
      const { owned, first } = await initializedPredecessor();
      await owned.run(async () => {
        const second = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          threadId: first.threadId,
          prompt: "initialize exactly one winning claim",
        });
        const responses = await Promise.all([
          api.requestClaimRunnerJob(true, second.runId, [200, 404]),
          api.requestClaimRunnerJob(true, second.runId, [200, 404]),
        ]);
        expect(
          responses
            .map((response) => {
              return response.status;
            })
            .sort(),
        ).toStrictEqual([200, 404]);
        const winner = responses.find((response) => {
          return response.status === 200;
        });
        if (!winner || winner.status !== 200) {
          throw new Error("Expected one winning Runner claim");
        }
        owned.rememberClaim(second.runId, winner.body.sandboxToken);
        expect(winner.body.nativeContinuation).toMatchObject({
          sessionId: first.threadId,
          generationRunId: first.runId,
        });
        const headers = { authorization: `Bearer ${winner.body.sandboxToken}` };
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
        await api.requestClaimRunnerJob(true, second.runId, [404]);
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
          agentId: owned.agentId,
          threadId: first.threadId,
          prompt: "resume the confirmed session after Runner settlement",
        });
        const nextClaim = await owned.claimRunnerRun(next.runId);
        expect(nextClaim.nativeContinuation).toMatchObject({
          sessionId,
          generationRunId: second.runId,
        });
      });
    },
  );
});
