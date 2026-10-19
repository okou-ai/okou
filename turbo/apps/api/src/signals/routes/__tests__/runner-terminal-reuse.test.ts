import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

async function terminalPredecessor(status: "cancelled" | "failed") {
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const owned = await publicChatActor(context, {
    isolatePg: true,
    clockTime: now,
  });
  const api = createRunsApi(context);
  const { actor, agentId, runnerGroup: group } = owned;
  const run = await owned.run(() => {
    return api.createThreadRun(actor, {
      agentId,
      prompt: "Preserve terminal home state",
    });
  });
  const runnerId = randomUUID();
  const fixture = { api, owned, actor, agentId, group, run, runnerId, clock };
  await heartbeat(fixture);
  const claimed = await owned.claimRunnerRun(run.runId, {
    runnerIdentity: { runnerId, heartbeatGeneration: 7 },
  });
  await owned.run(async () => {
    const webhooks = createWebhookCallbackApi(context);
    const headers = { authorization: `Bearer ${claimed.sandboxToken}` };
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
            message: { content: [{ type: "text", text: "Partial work" }] },
          },
        ],
      },
      headers,
      [200],
    );
    if (status === "cancelled") {
      await api.requestCancelRun(actor, run.runId, [200]);
    }
    // The cancellation request does not finish an executing Run. Drive the
    // normal terminal callback before asking the Thread to launch a successor.
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: status === "cancelled" ? 137 : 1,
        lastEventSequence: 1,
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
  });
  return fixture;
}

type Fixture = Awaited<ReturnType<typeof terminalPredecessor>>;

async function heartbeat(
  f: Pick<Fixture, "api" | "owned" | "group" | "runnerId">,
  args: Parameters<Fixture["api"]["requestHeartbeatRunner"]>[2] = {},
) {
  await f.owned.run(() => {
    return f.api.requestHeartbeatRunner(true, [200], {
      runnerId: f.runnerId,
      group: f.group,
      snapshotGeneration: 7,
      snapshotSequence: 1,
      heldHomeStates: [],
      heldSandboxStates: [],
      ...args,
    });
  });
}

async function continuation(f: Fixture) {
  return await f.owned.run(() => {
    return f.api.createThreadRun(f.actor, {
      agentId: f.agentId,
      threadId: f.run.threadId,
      prompt: "Continue after terminal cleanup",
    });
  });
}

async function poll(f: Fixture, runId: string) {
  return await f.owned.run(async () => {
    const response = await f.api.requestPollRunner(
      true,
      {
        runnerId: f.runnerId,
        group: f.group,
        supportedProfiles: ["vm0/default"],
      },
      [200],
    );
    if (response.status !== 200) {
      throw new Error("Expected authenticated Runner poll");
    }
    expect(response.body.job?.runId).toBe(runId);
    return response.body.job;
  });
}

describe("terminal predecessor reuse preference", () => {
  it.each(["cancelled", "failed"] as const)(
    "keeps the %s producer deadline identical in Ably and repeated polls",
    async (status) => {
      const f = await terminalPredecessor(status);
      const producer = {
        runId: f.run.runId,
        reuseKey: `thread:${f.run.threadId}`,
        profile: "vm0/default",
      };
      await heartbeat(f, {
        snapshotSequence: 2,
        activeReuseProducers: [producer],
      });
      context.mocks.ably.publish.mockClear();
      const next = await continuation(f);
      const preference = {
        kind: "preference",
        tier: "finalizingPredecessor",
        runnerIdentity: { runnerId: f.runnerId, heartbeatGeneration: 7 },
        expiresAt: new Date(
          f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
        ).toISOString(),
      };
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
        preference,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "job",
        expect.objectContaining({
          runId: next.runId,
          historyGenerationRunId: f.run.runId,
          runnerPreference: preference,
        }),
      );
      mockNow(f.clock + 2500);
      await heartbeat(f, {
        snapshotSequence: 3,
        activeReuseProducers: [producer],
      });
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual(
        preference,
      );
      mockNow(f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS);
      await heartbeat(f, {
        snapshotSequence: 4,
        activeReuseProducers: [producer],
      });
      expect((await poll(f, next.runId))?.runnerPreference).toStrictEqual({
        kind: "noPreference",
        reason: "expired",
      });
    },
  );

  it.each(["cancelled", "failed"] as const)(
    "bounds the %s completion bridge without producer proof",
    async (status) => {
      const f = await terminalPredecessor(status);
      mockNow(f.clock + 500);
      const next = await continuation(f);
      expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
        tier: "finalizingPredecessor",
        expiresAt: new Date(f.clock + 1500).toISOString(),
      });
      mockNow(f.clock + 1500);
      expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );

  it.each(["generation", "profile", "draining"] as const)(
    "rejects terminal producer evidence with a mismatched %s",
    async (mismatch) => {
      const f = await terminalPredecessor("cancelled");
      mockNow(f.clock + 2000);
      await heartbeat(f, {
        snapshotGeneration: mismatch === "generation" ? 8 : 7,
        snapshotSequence: 2,
        mode: mismatch === "draining" ? "draining" : "running",
        activeReuseProducers: [
          {
            runId: f.run.runId,
            reuseKey: `thread:${f.run.threadId}`,
            profile: mismatch === "profile" ? "vm0/large" : "vm0/default",
          },
        ],
      });
      const next = await continuation(f);
      expect((await poll(f, next.runId))?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );
});
