import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  peerContinuation,
  peerFinalizingFixture,
  peerHeartbeat,
  peerPoll,
} from "./helpers/peer-finalizing-fixture";

const context = testContext();

describe("source host probe preference", () => {
  it("notifies and polls the replacement after source shutdown without inventing a ready holder", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.sourceId, {
      mode: "stopping",
      activeReuseProducers: [],
    });
    mockNow(f.clock + 43_000);
    await peerHeartbeat(f, f.receiverId);
    const next = await peerContinuation(f);
    const preference = {
      kind: "preference",
      tier: "sourceHostProbe",
      runnerIdentity: { runnerId: f.receiverId, heartbeatGeneration: 8 },
      finalizingSourceRunId: f.source.runId,
      expiresAt: new Date(f.clock + 45_000).toISOString(),
    };
    expect((await peerPoll(f))?.runnerPreference).toStrictEqual(preference);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        runId: next.runId,
        runnerPreference: preference,
      }),
    );
    mockNow(f.clock + 44_000);
    expect((await peerPoll(f))?.runnerPreference).toStrictEqual(preference);
    mockNow(f.clock + 45_000);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
      reason: "expired",
    });
  });

  it.each(["home", "sandbox"] as const)(
    "prefers an actual %s on another host over a locality probe",
    async (resource) => {
      const f = await peerFinalizingFixture(context);
      await peerHeartbeat(f, f.sourceId, {
        mode: "stopping",
        activeReuseProducers: [],
      });
      const holderId = randomUUID();
      await peerHeartbeat(f, holderId, {
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
      await peerContinuation(f);
      expect((await peerPoll(f))?.runnerPreference).toMatchObject({
        tier: resource === "home" ? "sourceHomeCache" : "exactSandbox",
        runnerIdentity: { runnerId: holderId },
      });
    },
  );
});
