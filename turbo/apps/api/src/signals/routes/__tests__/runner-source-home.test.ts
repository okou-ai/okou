import { randomUUID } from "node:crypto";
import { RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import {
  sourceHomeContinuation,
  sourceHomeFixture,
  sourceHomeHeartbeat,
  sourceHomePoll,
} from "./helpers/source-home-fixture";

const context = testContext();

describe("source Home publication preference", () => {
  it("publishes and polls B before any home exists, and B's claim excludes a competing claim", async () => {
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.sourceId, { admittableProfiles: [] });
    const next = await sourceHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "sourceHome",
      home: {
        evidence: "expected",
        homeWaitUntil: new Date(
          f.clock + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
        ).toISOString(),
      },
      sourceRunId: f.source.runId,
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
      expiresAt: new Date(f.clock + 2000).toISOString(),
    };
    await expect(sourceHomePoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: preference,
    });
    expect(
      (await sourceHomePoll(f, f.sourceId))?.runnerPreference,
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
    await sourceHomeHeartbeat(f, f.sourceId, {
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
    const f = await sourceHomeFixture(context, { failBeforeInit: true });
    mockNow(f.clock + 2000);
    const next = await sourceHomeContinuation(f);
    const job = await sourceHomePoll(f);
    expect(job).toMatchObject({
      runId: next.runId,
      runnerPreference: {
        tier: "sourceHome",
        home: {
          evidence: "expected",
          homeWaitUntil: new Date(
            f.clock + 2000 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
          ).toISOString(),
        },
        sourceRunId: f.source.runId,
        runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
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
    const f = await sourceHomeFixture(context);
    mockNow(f.clock + 2000);
    const next = await sourceHomeContinuation(f);
    const expiresAt = new Date(f.clock + 4000).toISOString();
    const homeWaitUntil = new Date(
      f.clock + 2000 + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
    ).toISOString();
    for (const job of await Promise.all([
      sourceHomePoll(f),
      sourceHomePoll(f),
    ])) {
      expect(job).toMatchObject({
        runId: next.runId,
        runnerPreference: {
          tier: "sourceHome",
          home: { evidence: "expected", homeWaitUntil },
          expiresAt,
        },
      });
    }
    mockNow(f.clock + 3000);
    await sourceHomeHeartbeat(f, f.sourceId);
    await sourceHomeHeartbeat(f, f.receiverId);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      expiresAt,
      home: { homeWaitUntil },
    });
    mockNow(new Date(expiresAt).getTime());
    expect((await sourceHomePoll(f))?.runnerPreference).toStrictEqual({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it("uses A's completion bridge even when B advertises A's producer", async () => {
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.sourceId, { activeReuseProducers: [] });
    await sourceHomeHeartbeat(f, f.receiverId, {
      activeReuseProducers: [
        { runId: f.source.runId, reuseKey: f.reuseKey, profile: "vm0/default" },
      ],
    });
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "sourceHome",
      home: {
        evidence: "expected",
        homeWaitUntil: new Date(f.clock + 1500).toISOString(),
      },
      expiresAt: new Date(f.clock + 2000).toISOString(),
    });
    mockNow(f.clock + 1500);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "sourceHome",
      home: { evidence: "location" },
      expiresAt: new Date(f.clock + 2000).toISOString(),
    });
  });

  it.each(["cancelled", "failed"] as const)(
    "selects a receiver for a %s source after its real terminal callback",
    async (status) => {
      const f = await sourceHomeFixture(context, { status });
      await sourceHomeContinuation(f);
      expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
        tier: "sourceHome",
        home: { evidence: "expected" },
        runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
      });
    },
  );

  it("prioritizes the peer continuation ahead of an older ordinary job", async () => {
    const f = await sourceHomeFixture(context);
    await f.owned.run(() => {
      return f.api.createThreadRun(f.owned.actor, {
        agentId: f.owned.agentId,
        prompt: "An ordinary older job",
      });
    });
    const next = await sourceHomeContinuation(f);
    await expect(sourceHomePoll(f)).resolves.toMatchObject({
      runId: next.runId,
      runnerPreference: { tier: "sourceHome", home: { evidence: "expected" } },
    });
  });

  it("preserves stronger exact preference before returning to the peer producer", async () => {
    const f = await sourceHomeFixture(context);
    const ready = randomUUID();
    await sourceHomeHeartbeat(f, ready, {
      runnerHostname: "ready-other.example.test",
      heldSandboxStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          reusableSandbox: {
            profile: "vm0/default",
            sourceRunId: f.source.runId,
          },
        },
      ],
    });
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "exactSandbox",
      finalizingSourceRunId: f.source.runId,
      runnerIdentity: { runnerId: ready, heartbeatGeneration: 8 },
    });
    mockNow(f.clock + 1000);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "sourceHome",
      home: { evidence: "expected" },
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
    });
  });

  it("uses B's latest generation while preserving same-process finalization", async () => {
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.receiverId, {
      snapshotGeneration: 9,
      snapshotSequence: 1,
    });
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "sourceHome",
      home: { evidence: "expected" },
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 9 },
    });
    await sourceHomeHeartbeat(f, f.sourceId, { mode: "running" });
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "finalizingPredecessor",
      runnerIdentity: { runnerId: f.sourceId, heartbeatGeneration: 7 },
    });
  });

  it("keeps ready-home preference available when optional hostname is absent", async () => {
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.receiverId, {
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
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "homeCache",
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
    });
  });
});
