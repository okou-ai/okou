import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  PREDECESSOR_HOSTNAME,
  predecessorHomeContinuation,
  predecessorHomeFixture,
  predecessorHomeHeartbeat,
  predecessorHomePoll,
} from "./helpers/predecessor-home-fixture";

const context = testContext();

describe("predecessor Home publication evidence", () => {
  it("requires the winning source claim's hostname as well as matching heartbeats", async () => {
    const f = await predecessorHomeFixture(context, { claimHostname: null });
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });

  it.each(["source", "receiver"] as const)(
    "does not use an accepted PAT %s snapshot as finalizing ownership",
    async (role) => {
      const f = await predecessorHomeFixture(context);
      const pat = await f.owned.run(() => {
        return f.api.createCliToken(f.owned.actor);
      });
      await f.owned.run(() => {
        return f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
          runnerId:
            role === "source" ? f.predecessorRunnerId : f.receiverRunnerId,
          runnerHostname: PREDECESSOR_HOSTNAME,
          group: f.group,
          snapshotGeneration: role === "source" ? 7 : 8,
          snapshotSequence: 100,
          mode: role === "source" ? "draining" : "running",
          activeReuseProducers: [
            {
              runId: f.predecessorRun.runId,
              reuseKey: f.reuseKey,
              profile: "vm0/default",
            },
          ],
        });
      });
      mockNow(f.clock + 2000);
      await predecessorHomeContinuation(f);
      expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject(
        role === "source"
          ? { tier: "predecessorHome", home: { evidence: "location" } }
          : { kind: "noPreference" },
      );
    },
  );

  it.each(["source", "receiver"] as const)(
    "requires fresh recipient state without borrowing stale %s producer proof",
    async (role) => {
      const f = await predecessorHomeFixture(context);
      mockNow(f.clock + 30_001);
      await predecessorHomeHeartbeat(
        f,
        role === "source" ? f.receiverRunnerId : f.predecessorRunnerId,
      );
      await predecessorHomeContinuation(f);
      expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject(
        role === "source"
          ? { tier: "predecessorHome", home: { evidence: "location" } }
          : { kind: "noPreference" },
      );
    },
  );

  it.each(["run", "reuseKey", "profile"] as const)(
    "does not earn a post-bridge window from the wrong producer %s",
    async (field) => {
      const f = await predecessorHomeFixture(context);
      await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
        activeReuseProducers: [
          {
            runId: field === "run" ? randomUUID() : f.predecessorRun.runId,
            reuseKey: field === "reuseKey" ? "thread:unrelated" : f.reuseKey,
            profile: field === "profile" ? "vm0/other" : "vm0/default",
          },
        ],
      });
      mockNow(f.clock + 2000);
      await predecessorHomeContinuation(f);
      expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
        tier: "predecessorHome",
        home: { evidence: "location" },
        expiresAt: new Date(f.clock + 4000).toISOString(),
      });
    },
  );

  it("does not let a stale hostname heartbeat undo a newer accepted snapshot", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.receiverRunnerId, {
      runnerHostname: "different-host.example.test",
    });
    await predecessorHomeHeartbeat(f, f.receiverRunnerId, {
      snapshotSequence: 1,
    });
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await predecessorHomeHeartbeat(f, f.receiverRunnerId);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "predecessorHome",
      home: { evidence: "expected" },
    });
  });

  it("does not borrow another draining process's producer for the winning source", async () => {
    const f = await predecessorHomeFixture(context);
    await predecessorHomeHeartbeat(f, f.predecessorRunnerId, {
      snapshotGeneration: 8,
      activeReuseProducers: [],
    });
    await predecessorHomeHeartbeat(f, randomUUID(), {
      mode: "draining",
      activeReuseProducers: [
        {
          runId: f.predecessorRun.runId,
          reuseKey: f.reuseKey,
          profile: "vm0/default",
        },
      ],
    });
    mockNow(f.clock + 2000);
    await predecessorHomeContinuation(f);
    expect((await predecessorHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "predecessorHome",
      home: { evidence: "location" },
    });
  });
});
