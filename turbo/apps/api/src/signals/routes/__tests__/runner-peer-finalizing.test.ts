import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import {
  peerContinuation,
  peerFinalizingFixture,
  peerHeartbeat,
  peerPoll,
} from "./helpers/peer-finalizing-fixture";

const context = testContext();

describe("same-host draining predecessor preference", () => {
  it("publishes and polls B before any home exists, and B's claim excludes a competing claim", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.sourceId, { admittableProfiles: [] });
    const next = await peerContinuation(f);
    const preference = {
      kind: "preference",
      tier: "peerFinalizingPredecessor",
      finalizingSourceRunId: f.source.runId,
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
      expiresAt: new Date(
        f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
      ).toISOString(),
    };
    await expect(peerPoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: preference,
    });
    expect((await peerPoll(f, f.sourceId))?.runnerPreference).toStrictEqual(
      preference,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: preference,
      }),
    );
    const claimed = await f.owned.claimRunnerRun(next.runId, {
      runnerIdentity: preference.runnerIdentity,
    });
    await f.owned.run(() => {
      return f.api.requestClaimRunnerJob(true, next.runId, [404], {
        runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 1 },
      });
    });
    // The successful claim precedes the first published-home observation.
    await peerHeartbeat(f, f.sourceId, {
      activeReuseProducers: [],
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 }],
        },
      ],
    });
    await f.owned.run(() => {
      return completePublicClaudeRun(
        context,
        next,
        { authorization: `Bearer ${claimed.sandboxToken}` },
        "Continued after publication",
      );
    });
  });

  it("selects a draining failed source with no native history before initialization", async () => {
    const f = await peerFinalizingFixture(context, { failBeforeInit: true });
    mockNow(f.clock + 2000);
    const next = await peerContinuation(f);
    const job = await peerPoll(f);
    expect(job?.historyGenerationRunId).toBeUndefined();
    expect(job).toMatchObject({
      runId: next.runId,
      runnerPreference: {
        tier: "peerFinalizingPredecessor",
        finalizingSourceRunId: f.source.runId,
        runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
        expiresAt: new Date(
          f.clock + 2000 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
        ).toISOString(),
      },
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: job?.runnerPreference,
      }),
    );
  });

  it("keeps A's producer window after the bridge with B empty and does not renew it", async () => {
    const f = await peerFinalizingFixture(context);
    mockNow(f.clock + 2000);
    const next = await peerContinuation(f);
    const expiresAt = new Date(
      f.clock + 2000 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
    ).toISOString();
    for (const job of await Promise.all([peerPoll(f), peerPoll(f)])) {
      expect(job).toMatchObject({
        runId: next.runId,
        runnerPreference: { tier: "peerFinalizingPredecessor", expiresAt },
      });
    }
    mockNow(f.clock + 30_000);
    await peerHeartbeat(f, f.sourceId);
    await peerHeartbeat(f, f.receiverId);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({ expiresAt });
    mockNow(new Date(expiresAt).getTime());
    expect((await peerPoll(f))?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("uses A's completion bridge even when B advertises A's producer", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.sourceId, { activeReuseProducers: [] });
    await peerHeartbeat(f, f.receiverId, {
      activeReuseProducers: [
        { runId: f.source.runId, reuseKey: f.reuseKey, profile: "vm0/default" },
      ],
    });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "peerFinalizingPredecessor",
      expiresAt: new Date(f.clock + 1500).toISOString(),
    });
    mockNow(f.clock + 1500);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });

  it.each(["cancelled", "failed"] as const)(
    "selects a receiver for a %s source after its real terminal callback",
    async (status) => {
      const f = await peerFinalizingFixture(context, { status });
      await peerContinuation(f);
      expect((await peerPoll(f))?.runnerPreference).toMatchObject({
        tier: "peerFinalizingPredecessor",
        runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
      });
    },
  );

  it("prioritizes the peer continuation ahead of an older ordinary job", async () => {
    const f = await peerFinalizingFixture(context);
    await f.owned.run(() => {
      return f.api.createThreadRun(f.owned.actor, {
        agentId: f.owned.agentId,
        prompt: "An ordinary older job",
      });
    });
    const next = await peerContinuation(f);
    await expect(peerPoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: { tier: "peerFinalizingPredecessor" },
    });
  });

  it("preserves stronger exact preference before returning to the peer producer", async () => {
    const f = await peerFinalizingFixture(context);
    const ready = randomUUID();
    await peerHeartbeat(f, ready, {
      runnerHostname: "ready-other.example.test",
      heldSandboxStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: {
            profile: "vm0/default",
            historyGenerationRunId: f.source.runId,
            sourceRunId: f.source.runId,
          },
        },
      ],
    });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "exactSandbox",
      finalizingSourceRunId: f.source.runId,
      runnerIdentity: { runnerId: ready, heartbeatGeneration: 8 },
    });
    mockNow(f.clock + 1000);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "peerFinalizingPredecessor",
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
    });
  });

  it("uses B's latest generation while preserving same-process finalization", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.receiverId, {
      snapshotGeneration: 9,
      snapshotSequence: 1,
    });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "peerFinalizingPredecessor",
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 9 },
    });
    await peerHeartbeat(f, f.sourceId, { mode: "running" });
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      runnerIdentity: { runnerId: f.sourceId, heartbeatGeneration: 7 },
    });
  });

  it("keeps ready-home preference available when optional hostname is absent", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.receiverId, {
      runnerHostname: undefined,
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          homeCaches: [{ profile: "vm0/default", homeAffinityVersion: 1 }],
        },
      ],
    });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "homeCache",
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
    });
  });
});
