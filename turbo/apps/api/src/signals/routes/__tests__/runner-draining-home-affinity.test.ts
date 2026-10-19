import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";

const context = testContext();

async function setup() {
  const scopes = { "vm0/default": "a".repeat(64) };
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const api = createRunsApi(context);
  const owned = await publicChatActor(context, {
    isolatePg: true,
    clockTime: now,
  });
  const { actor, agentId, runnerGroup: group } = owned;
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const first = await owned.run(() => {
    return api.createThreadRun(actor, {
      agentId,
      prompt: "Produce reusable home",
    });
  });
  const reuseKey = `thread:${first.threadId}`;
  const heartbeat = (
    args: Parameters<typeof api.requestHeartbeatRunner>[2],
  ) => {
    return owned.run(() => {
      return api.requestHeartbeatRunner(true, [200], { group, ...args });
    });
  };
  await heartbeat({
    runnerId: sourceId,
    snapshotGeneration: 7,
    homeCacheScopes: scopes,
  });
  const claimed = await owned.claimRunnerRun(first.runId, {
    runnerIdentity: { runnerId: sourceId, heartbeatGeneration: 7 },
  });
  await owned.run(() => {
    return completePublicClaudeRun(
      context,
      first,
      { authorization: `Bearer ${claimed.sandboxToken}` },
      "Saved native predecessor",
    );
  });
  const producer = { runId: first.runId, reuseKey, profile: "vm0/default" };
  const source = {
    runnerId: sourceId,
    snapshotGeneration: 7,
    snapshotSequence: 2,
    mode: "draining" as const,
    homeCacheScopes: scopes,
    activeReuseProducers: [producer],
  };
  const target = {
    runnerId: targetId,
    snapshotGeneration: 3,
    homeCacheScopes: scopes,
  };
  await heartbeat(source);
  await heartbeat(target);
  const continuation = () => {
    return owned.run(() => {
      return api.createThreadRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "Continue on the shared home",
      });
    });
  };
  const poll = (runnerId = targetId) => {
    return owned.run(async () => {
      const response = await api.requestPollRunner(
        true,
        { runnerId, group, supportedProfiles: ["vm0/default"] },
        [200],
      );
      if (response.status !== 200) {
        throw new Error("Expected authenticated poll");
      }
      return response.body.job;
    });
  };
  return {
    api,
    owned,
    actor,
    agentId,
    clock,
    group,
    first,
    reuseKey,
    sourceId,
    targetId,
    source,
    target,
    producer,
    heartbeat,
    continuation,
    poll,
  };
}

describe("draining predecessor shared-home preference", () => {
  it("prioritizes the capable replacement in poll and Ably under one absolute producer deadline", async () => {
    const f = await setup();
    // This older generic job would otherwise win the recipient's poll ordering.
    const generic = await f.owned.run(() => {
      return f.api.createThreadRun(f.actor, {
        agentId: f.agentId,
        prompt: "Unrelated generic work",
      });
    });
    mockNow(f.clock + 1);
    const next = await f.continuation();
    await f.owned.run(flushWaitUntilForTest);
    const expected = {
      kind: "preference",
      tier: "finalizingPredecessor",
      runnerIdentity: { runnerId: f.targetId, heartbeatGeneration: 3 },
      expiresAt: new Date(
        f.clock + 1 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
      ).toISOString(),
    };
    const job = await f.poll();
    expect(job?.runId).toBe(next.runId);
    expect(job?.runnerPreference).toStrictEqual(expected);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: expected,
      }),
    );
    const remote = randomUUID();
    expect((await f.poll(remote))?.runId).toBe(generic.runId);
    await f.owned.run(async () => {
      await f.api.requestCancelRun(f.actor, generic.runId, [200]);
      await flushWaitUntilForTest();
    });
    mockNow(f.clock + 5000);
    await f.heartbeat({ ...f.source, snapshotSequence: 3 });
    expect((await f.poll())?.runnerPreference).toStrictEqual(expected);
    mockNow(f.clock + 1 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS);
    await f.heartbeat({ ...f.source, snapshotSequence: 4 });
    await f.heartbeat({ ...f.target, snapshotSequence: 2 });
    const expired = await f.poll();
    expect(expired?.runId).toBe(next.runId);
    // Neither rediscovery nor fresh producer evidence creates a new window.
    expect(expired?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("selects a replacement with an already committed home without adopting the draining sandbox", async () => {
    const f = await setup();
    await f.heartbeat({
      ...f.target,
      snapshotSequence: 2,
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: nowDate().toISOString(),
          homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 }],
        },
      ],
    });
    const next = await f.continuation();
    await expect(f.poll()).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: {
        kind: "preference",
        tier: "finalizingPredecessor",
        runnerIdentity: { runnerId: f.targetId, heartbeatGeneration: 3 },
      },
    });
  });

  it.each([
    "other-domain",
    "old-source",
    "old-recipient",
    "full-recipient",
    "draining-recipient",
    "source-restart",
    "producer-failed",
    "wrong-producer",
    "recipient-only-producer",
    "wrong-profile",
    "stale-source",
    "stale-recipient",
  ] as const)("falls back for %s evidence", async (scenario) => {
    const f = await setup();
    if (scenario === "old-source") {
      await f.heartbeat({
        ...f.source,
        snapshotSequence: 3,
        homeCacheScopes: undefined,
      });
    }
    if (scenario === "wrong-profile") {
      await f.heartbeat({
        ...f.target,
        snapshotSequence: 2,
        homeCacheScopes: { "vm0/large": "a".repeat(64) },
      });
    }
    if (scenario === "stale-source" || scenario === "stale-recipient") {
      mockNow(f.clock + 31_000);
      await f.heartbeat(
        scenario === "stale-source"
          ? { ...f.target, snapshotSequence: 2 }
          : { ...f.source, snapshotSequence: 3 },
      );
    }
    if (scenario === "old-recipient") {
      await f.heartbeat({
        ...f.target,
        snapshotSequence: 2,
        homeCacheScopes: undefined,
      });
    }
    if (scenario === "other-domain") {
      await f.heartbeat({
        ...f.target,
        snapshotSequence: 2,
        homeCacheScopes: { "vm0/default": "b".repeat(64) },
      });
    }
    if (scenario === "full-recipient") {
      await f.heartbeat({
        ...f.target,
        snapshotSequence: 2,
        admittableProfiles: [],
      });
    }
    if (scenario === "draining-recipient") {
      await f.heartbeat({ ...f.target, snapshotSequence: 2, mode: "draining" });
    }
    if (scenario === "source-restart") {
      await f.heartbeat({
        ...f.source,
        snapshotGeneration: 8,
        snapshotSequence: 1,
      });
    }
    if (scenario === "producer-failed" || scenario === "wrong-producer") {
      mockNow(f.clock + 2000);
      await f.heartbeat({
        ...f.source,
        snapshotSequence: 3,
        activeReuseProducers:
          scenario === "producer-failed"
            ? []
            : [{ ...f.producer, reuseKey: "thread:someone-else" }],
      });
    }
    if (scenario === "recipient-only-producer") {
      mockNow(f.clock + 2000);
      await f.heartbeat({
        ...f.source,
        snapshotSequence: 3,
        activeReuseProducers: [],
      });
      await f.heartbeat({
        ...f.target,
        snapshotSequence: 2,
        activeReuseProducers: [f.producer],
      });
    }
    const next = await f.continuation();
    await expect(f.poll()).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: { kind: "noPreference" },
    });
  });

  it("fences old recipient snapshots after restart and binds a new preference to the new generation", async () => {
    const f = await setup();
    await f.continuation();
    const initial = (await f.poll())?.runnerPreference;
    expect(initial).toMatchObject({
      kind: "preference",
      runnerIdentity: { heartbeatGeneration: 3 },
    });
    await f.heartbeat({
      ...f.target,
      snapshotGeneration: 4,
      snapshotSequence: 1,
      homeCacheScopes: undefined,
    });
    await f.heartbeat({ ...f.target, snapshotSequence: 100 });
    expect((await f.poll())?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await f.heartbeat({
      ...f.target,
      snapshotGeneration: 4,
      snapshotSequence: 2,
    });
    expect((await f.poll())?.runnerPreference).toStrictEqual({
      ...initial,
      runnerIdentity: { runnerId: f.targetId, heartbeatGeneration: 4 },
    });
  });

  it("rejects PAT-supplied cache-domain authority", async () => {
    const f = await setup();
    const pat = await f.owned.run(() => {
      return f.api.createCliToken(f.actor);
    });
    await f.owned.run(() => {
      return f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
        ...f.target,
        group: f.group,
        snapshotSequence: 2,
      });
    });
    await f.continuation();
    expect((await f.poll())?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });
});
