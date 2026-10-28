import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import {
  predecessorHomeContinuation,
  predecessorHomeFixture,
  predecessorHomeHeartbeat,
  predecessorHomePoll,
} from "./helpers/predecessor-home-fixture";

const context = testContext();

describe("predecessor Home publication preference", () => {
  it("publishes and polls B before any home exists, and B's claim excludes a competing claim", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
      admittableProfiles: [],
    });
    const next = await predecessorHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "predecessorHome",
      home: {
        evidence: "expected",
        homeWaitUntil: new Date(
          f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
        ).toISOString(),
      },
      predecessorRunId: f.predecessorRun.runId,
      runnerIdentity: { runnerId: f.receiverRunnerId, heartbeatGeneration: 8 },
      expiresAt: new Date(f.clock + 2000).toISOString(),
    };
    await expect(predecessorHomePoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: preference,
    });
    expect(
      (await predecessorHomePoll(f, f.predecessorRunnerId))?.runnerPreference,
    ).toStrictEqual(preference);
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
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
      activeReuseProducers: [],
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          homeCaches: [
            {
              sourceRunId: "33333333-3333-4333-8333-333333333333",
              profile: "vm0/default",
              homeAffinityVersion: 1,
            },
          ],
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
    const f = await predecessorHomeFixture(context, { failBeforeInit: true });
    mockNow(f.clock + 2000);
    const next = await predecessorHomeContinuation(f);
    const job = await predecessorHomePoll(f);
    expect(job).toMatchObject({
      runId: next.runId,
      runnerPreference: {
        tier: "predecessorHome",
        home: {
          evidence: "expected",
          homeWaitUntil: new Date(
            f.clock + 2000 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
          ).toISOString(),
        },
        predecessorRunId: f.predecessorRun.runId,
        runnerIdentity: {
          runnerId: f.receiverRunnerId,
          heartbeatGeneration: 8,
        },
        expiresAt: new Date(f.clock + 4000).toISOString(),
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

  it("bounds unclaimed routing independently of publication waiting and does not renew either", async () => {
    const f = await predecessorHomeFixture(context);
    mockNow(f.clock + 2000);
    const next = await predecessorHomeContinuation(f);
    const expiresAt = new Date(f.clock + 4000).toISOString();
    const homeWaitUntil = new Date(
      f.clock + 2000 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
    ).toISOString();
    for (const job of await Promise.all([
      predecessorHomePoll(f),
      predecessorHomePoll(f),
    ])) {
      expect(job).toMatchObject({
        runId: next.runId,
        runnerPreference: {
          tier: "predecessorHome",
          home: { evidence: "expected", homeWaitUntil },
          expiresAt,
        },
      });
    }
    mockNow(f.clock + 3000);
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId);
    await predecessorHomeHeartbeat(f, f.receiverRunnerId);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      expiresAt,
      home: { homeWaitUntil },
    });
    mockNow(new Date(expiresAt).getTime());
    expect((await predecessorHomePoll(f))?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("uses A's completion bridge even when B advertises A's producer", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
      activeReuseProducers: [],
    });
    await predecessorHomeHeartbeat(f, f.receiverRunnerId, {
      activeReuseProducers: [
        {
          runId: f.predecessorRun.runId,
          reuseKey: f.reuseKey,
          profile: "vm0/default",
        },
      ],
    });
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "predecessorHome",
      home: {
        evidence: "expected",
        homeWaitUntil: new Date(f.clock + 1500).toISOString(),
      },
      expiresAt: new Date(f.clock + 2000).toISOString(),
    });
    mockNow(f.clock + 1500);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "predecessorHome",
      home: { evidence: "location" },
      expiresAt: new Date(f.clock + 2000).toISOString(),
    });
  });

  it.each(["cancelled", "failed"] as const)(
    "selects a receiver for a %s source after its real terminal callback",
    async (status) => {
      const f = await predecessorHomeFixture(context, { status });
      await predecessorHomeContinuation(f);
      expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
        tier: "predecessorHome",
        home: { evidence: "expected" },
        runnerIdentity: {
          runnerId: f.receiverRunnerId,
          heartbeatGeneration: 8,
        },
      });
    },
  );

  it("prioritizes the peer continuation ahead of an older ordinary job", async () => {
    const f = await predecessorHomeFixture(context);
    await f.owned.run(() => {
      return f.api.createThreadRun(f.owned.actor, {
        agentId: f.owned.agentId,
        prompt: "An ordinary older job",
      });
    });
    const next = await predecessorHomeContinuation(f);
    await expect(predecessorHomePoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: {
        tier: "predecessorHome",
        home: { evidence: "expected" },
      },
    });
  });

  it("preserves stronger exact preference before returning to the peer producer", async () => {
    const f = await predecessorHomeFixture(context);
    const ready = randomUUID();
    await predecessorHomeHeartbeat(f, ready, {
      runnerHostname: "ready-other.example.test",
      heldSandboxStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: {
            profile: "vm0/default",
            sourceRunId: f.predecessorRun.runId,
          },
        },
      ],
    });
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "exactSandbox",
      predecessorRunId: f.predecessorRun.runId,
      runnerIdentity: { runnerId: ready, heartbeatGeneration: 8 },
    });
    mockNow(f.clock + 1000);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "predecessorHome",
      home: { evidence: "expected" },
      runnerIdentity: { runnerId: f.receiverRunnerId, heartbeatGeneration: 8 },
    });
  });

  it("uses B's latest generation while preserving same-process finalization", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.receiverRunnerId, {
      snapshotGeneration: 9,
      snapshotSequence: 1,
    });
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "predecessorHome",
      home: { evidence: "expected" },
      runnerIdentity: { runnerId: f.receiverRunnerId, heartbeatGeneration: 9 },
    });
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
      mode: "running",
    });
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      runnerIdentity: {
        runnerId: f.predecessorRunnerId,
        heartbeatGeneration: 7,
      },
    });
  });

  it("keeps ready-home preference available when optional hostname is absent", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.receiverRunnerId, {
      runnerHostname: undefined,
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          homeCaches: [
            {
              sourceRunId: "33333333-3333-4333-8333-333333333333",
              profile: "vm0/default",
              homeAffinityVersion: 1,
            },
          ],
        },
      ],
    });
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "homeCache",
      runnerIdentity: { runnerId: f.receiverRunnerId, heartbeatGeneration: 8 },
    });
  });
});
