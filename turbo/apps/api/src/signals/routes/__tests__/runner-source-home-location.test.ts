import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  sourceHomeContinuation,
  sourceHomeFixture,
  sourceHomeHeartbeat,
  sourceHomePoll,
} from "./helpers/source-home-fixture";

const context = testContext();

describe("source Home location and advertised readiness", () => {
  it("routes to an advertised exact-source Home instead of waiting for a producer elsewhere", async () => {
    const f = await sourceHomeFixture(context);
    const holderId = randomUUID();
    await sourceHomeHeartbeat(f, holderId, {
      runnerHostname: "ready-source-home.example.test",
      heldHomeStates: [
        {
          reuseKey: f.reuseKey,
          lastCompletedAt: new Date(f.clock).toISOString(),
          homeCaches: [
            {
              profile: "vm0/default",
              sourceRunId: f.source.runId,
              homeAffinityVersion: 1,
            },
          ],
        },
      ],
    });
    const next = await sourceHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "sourceHome",
      sourceRunId: f.source.runId,
      runnerIdentity: { runnerId: holderId, heartbeatGeneration: 8 },
      expiresAt: new Date(f.clock + 2000).toISOString(),
      home: { evidence: "advertised" },
    };
    expect((await sourceHomePoll(f))?.runnerPreference).toStrictEqual(
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
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.sourceId, {
      mode: "stopping",
      activeReuseProducers: [],
    });
    mockNow(f.clock + 43_000);
    await sourceHomeHeartbeat(f, f.receiverId);
    const next = await sourceHomeContinuation(f);
    const preference = {
      kind: "preference",
      tier: "sourceHome",
      home: { evidence: "location" },
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
      sourceRunId: f.source.runId,
      expiresAt: new Date(f.clock + 45_000).toISOString(),
    };
    expect((await sourceHomePoll(f))?.runnerPreference).toStrictEqual(
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
    expect((await sourceHomePoll(f))?.runnerPreference).toStrictEqual(
      preference,
    );
    mockNow(f.clock + 45_000);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it.each(["home", "sandbox"] as const)(
    "prefers an actual %s on another host over a locality probe",
    async (resource) => {
      const f = await sourceHomeFixture(context);
      await sourceHomeHeartbeat(f, f.sourceId, {
        mode: "stopping",
        activeReuseProducers: [],
      });
      const holderId = randomUUID();
      await sourceHomeHeartbeat(f, holderId, {
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
                      sourceRunId: f.source.runId,
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
                    sourceRunId: f.source.runId,
                  },
                },
              ],
            }),
      });
      await sourceHomeContinuation(f);
      expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
        tier: resource === "home" ? "sourceHome" : "exactSandbox",
        ...(resource === "home" ? { home: { evidence: "advertised" } } : {}),
        runnerIdentity: { runnerId: holderId },
      });
    },
  );
});
