import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  predecessorHomeContinuation,
  predecessorHomeFixture,
  predecessorHomeHeartbeat,
  predecessorHomePoll,
} from "./helpers/predecessor-home-fixture";

const context = testContext();

describe("predecessor Home location and advertised readiness", () => {
  it("routes to an advertised predecessor Home instead of waiting for a producer elsewhere", async () => {
    const f = await predecessorHomeFixture(context);
    const holderId = randomUUID();
    await predecessorHomeHeartbeat(f, holderId, {
      runnerHostname: "ready-source-home.example.test",
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          homeCaches: [
            {
              profile: "vm0/default",
              sourceRunId: f.predecessorRun.runId,
              homeAffinityVersion: 1,
            },
          ],
        },
      ],
    });
    const next = await predecessorHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "predecessorHome",
      predecessorRunId: f.predecessorRun.runId,
      runnerIdentity: { runnerId: holderId, heartbeatGeneration: 8 },
      expiresAt: new Date(f.clock + 2000).toISOString(),
      home: { evidence: "advertised" },
    };
    expect((await predecessorHomePoll(f))?.runnerPreference).toStrictEqual(
      preference,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: preference,
      }),
    );
  });

  it("notifies and polls the replacement after source shutdown without inventing a ready holder", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
      mode: "stopping",
      activeReuseProducers: [],
    });
    mockNow(f.clock + 43_000);
    await predecessorHomeHeartbeat(f, f.receiverRunnerId);
    const next = await predecessorHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "predecessorHome",
      home: { evidence: "location" },
      runnerIdentity: { runnerId: f.receiverRunnerId, heartbeatGeneration: 8 },
      predecessorRunId: f.predecessorRun.runId,
      expiresAt: new Date(f.clock + 45_000).toISOString(),
    };
    expect((await predecessorHomePoll(f))?.runnerPreference).toStrictEqual(
      preference,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: preference,
      }),
    );
    mockNow(f.clock + 44_000);
    expect((await predecessorHomePoll(f))?.runnerPreference).toStrictEqual(
      preference,
    );
    mockNow(f.clock + 45_000);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it.each(["home", "sandbox"] as const)(
    "prefers an actual %s on another host over a locality probe",
    async (resource) => {
      const f = await predecessorHomeFixture(context);
      await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
        mode: "stopping",
        activeReuseProducers: [],
      });
      const holderId = randomUUID();
      await predecessorHomeHeartbeat(f, holderId, {
        runnerHostname: "actual-holder.example.test",
        ...(resource === "home"
          ? {
              heldHomeStates: [
                {
                  reuseKey: f.reuseKey,
                  lastCompletedAt: new Date(f.clock).toISOString(),
                  homeCaches: [
                    {
                      profile: "vm0/default",
                      sourceRunId: f.predecessorRun.runId,
                      homeAffinityVersion: 1 as const,
                    },
                  ],
                },
              ],
            }
          : {
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
            }),
      });
      await predecessorHomeContinuation(f);
      expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
        tier: resource === "home" ? "predecessorHome" : "exactSandbox",
        ...(resource === "home" ? { home: { evidence: "advertised" } } : {}),
        runnerIdentity: { runnerId: holderId },
      });
    },
  );
});
