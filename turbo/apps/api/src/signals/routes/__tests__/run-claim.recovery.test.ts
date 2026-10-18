import { cronCleanupSandboxesContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();

async function cleanupSilentRuns() {
  await accept(
    (
      await setupApp({
        context,
        routes: cronCleanupSandboxesRoutes,
        isolatePg: true,
      })
    )(cronCleanupSandboxesContract).cleanup({
      headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

describe("Runner claim durable recovery", () => {
  it("keeps a long-queued Run alive when claiming overlaps maintenance", async () => {
    onTestFinished(clearMockNow);
    const chat = await publicChatActor(context, {
      isolatePg: true,
      restoreEnvironment: clearMockNow,
    });
    const api = createRunsApi(context);
    const currentTime = now();
    mockNow(currentTime - 180_000);
    const queued = await chat.sendChatRun(chat.actor, {
      agentId: chat.agentId,
      prompt: "start after a long queue wait",
    });
    mockNow(currentTime);
    await Promise.all([
      chat.claimChatRun(chat.runnerGroup, queued.runId),
      chat.run(cleanupSilentRuns),
    ]);
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "running",
    );
    expect((await api.readRunQueue(chat.actor)).body.concurrency.active).toBe(
      1,
    );
  });

  it("recovers a claimed Run without sandbox heartbeat and admits its successor", async () => {
    onTestFinished(clearMockNow);
    const chat = await publicChatActor(context, {
      isolatePg: true,
      restoreEnvironment: clearMockNow,
    });
    const api = createRunsApi(context);
    const queued = await chat.sendChatRun(chat.actor, {
      agentId: chat.agentId,
      prompt: "claim without starting a sandbox",
    });
    await chat.claimChatRun(chat.runnerGroup, queued.runId);
    const running = await api.readRun(chat.actor, queued.runId);
    if (!running.startedAt) {
      throw new Error("Expected the public Run to expose its claim time");
    }
    const claimedAt = Date.parse(running.startedAt);
    mockNow(claimedAt + 119_999);
    await cleanupSilentRuns();
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "running",
    );
    expect((await api.readRunQueue(chat.actor)).body.concurrency.active).toBe(
      1,
    );

    mockNow(claimedAt + 120_001);
    await cleanupSilentRuns();
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "timeout",
    );
    expect((await api.readRunQueue(chat.actor)).body.concurrency.active).toBe(
      0,
    );
    const replay = await api.requestClaimRunnerJob(true, queued.runId, [404]);
    expect(replay.status).toBe(404);

    const successor = await chat.sendChatRun(chat.actor, {
      agentId: chat.agentId,
      threadId: queued.threadId,
      prompt: "continue after undelivered execution",
    });
    expect(successor.runId).not.toBe(queued.runId);
    const { claim } = await chat.claimChatRun(
      chat.runnerGroup,
      successor.runId,
    );
    expect(claim.runId).toBe(successor.runId);
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "timeout",
    );
  });

  it("releases a silent cancelled claim without changing its terminal status", async () => {
    onTestFinished(clearMockNow);
    const chat = await publicChatActor(context, {
      isolatePg: true,
      restoreEnvironment: clearMockNow,
    });
    const api = createRunsApi(context);
    const queued = await chat.sendChatRun(chat.actor, {
      agentId: chat.agentId,
      prompt: "cancel before the claimed sandbox starts",
    });
    await chat.claimChatRun(chat.runnerGroup, queued.runId);
    await api.requestCancelRun(chat.actor, queued.runId, [200]);
    const cancelled = await api.readRun(chat.actor, queued.runId);
    expect(cancelled.status).toBe("cancelled");
    expect((await api.readRunQueue(chat.actor)).body.concurrency.active).toBe(
      1,
    );
    if (!cancelled.completedAt || !cancelled.startedAt) {
      throw new Error(
        "Expected claim and cancellation times on the public Run",
      );
    }
    mockNow(
      Math.max(
        Date.parse(cancelled.completedAt),
        Date.parse(cancelled.startedAt),
      ) + 120_001,
    );
    await cleanupSilentRuns();
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "cancelled",
    );
    expect((await api.readRunQueue(chat.actor)).body.concurrency.active).toBe(
      0,
    );
    const replay = await api.requestClaimRunnerJob(true, queued.runId, [404]);
    expect(replay.status).toBe(404);
  });

  it("leaves a claim without continuation support queued for a compatible Runner", async () => {
    const chat = await publicChatActor(context, { isolatePg: true });
    const api = createRunsApi(context);
    const queued = await chat.sendChatRun(chat.actor, {
      agentId: chat.agentId,
      prompt: "wait for a compatible Runner",
    });
    const rejected = await api.requestClaimRunnerJob(
      true,
      queued.runId,
      [404],
      {
        // Omit the optional advertisement from the serialized claim request.
        nativeContinuationSupported: undefined,
      },
    );
    expect(rejected.status).toBe(404);
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "pending",
    );
    const { claim } = await chat.claimChatRun(chat.runnerGroup, queued.runId);
    expect(claim.runId).toBe(queued.runId);
    expect((await api.readRun(chat.actor, queued.runId)).status).toBe(
      "running",
    );
  });
});
