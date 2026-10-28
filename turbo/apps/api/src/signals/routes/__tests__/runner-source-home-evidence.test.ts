import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  SOURCE_HOME_HOSTNAME,
  sourceHomeContinuation,
  sourceHomeFixture,
  sourceHomeHeartbeat,
  sourceHomePoll,
} from "./helpers/source-home-fixture";

const context = testContext();

describe("source Home publication evidence", () => {
  it("requires the winning source claim's hostname as well as matching heartbeats", async () => {
    const f = await sourceHomeFixture(context, { claimHostname: null });
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });

  it.each(["source", "receiver"] as const)(
    "does not use an accepted PAT %s snapshot as finalizing ownership",
    async (role) => {
      const f = await sourceHomeFixture(context);
      const pat = await f.owned.run(() => {
        return f.api.createCliToken(f.owned.actor);
      });
      await f.owned.run(() => {
        return f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
          runnerId: role === "source" ? f.sourceId : f.receiverId,
          runnerHostname: SOURCE_HOME_HOSTNAME,
          group: f.group,
          snapshotGeneration: role === "source" ? 7 : 8,
          snapshotSequence: 100,
          mode: role === "source" ? "draining" : "running",
          activeReuseProducers: [
            {
              runId: f.source.runId,
              reuseKey: f.reuseKey,
              profile: "vm0/default",
            },
          ],
        });
      });
      mockNow(f.clock + 2000);
      await sourceHomeContinuation(f);
      expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject(
        role === "source"
          ? { tier: "sourceHome", home: { evidence: "location" } }
          : { kind: "noPreference" },
      );
    },
  );

  it.each(["source", "receiver"] as const)(
    "requires fresh recipient state without borrowing stale %s producer proof",
    async (role) => {
      const f = await sourceHomeFixture(context);
      mockNow(f.clock + 30_001);
      await sourceHomeHeartbeat(
        f,
        role === "source" ? f.receiverId : f.sourceId,
      );
      await sourceHomeContinuation(f);
      expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject(
        role === "source"
          ? { tier: "sourceHome", home: { evidence: "location" } }
          : { kind: "noPreference" },
      );
    },
  );

  it.each(["run", "reuseKey", "profile"] as const)(
    "does not earn a post-bridge window from the wrong producer %s",
    async (field) => {
      const f = await sourceHomeFixture(context);
      await sourceHomeHeartbeat(f, f.sourceId, {
        activeReuseProducers: [
          {
            runId: field === "run" ? randomUUID() : f.source.runId,
            reuseKey: field === "reuseKey" ? "thread:unrelated" : f.reuseKey,
            profile: field === "profile" ? "vm0/other" : "vm0/default",
          },
        ],
      });
      mockNow(f.clock + 2000);
      await sourceHomeContinuation(f);
      expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
        tier: "sourceHome",
        home: { evidence: "location" },
        expiresAt: new Date(f.clock + 4000).toISOString(),
      });
    },
  );

  it("does not let a stale hostname heartbeat undo a newer accepted snapshot", async () => {
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.receiverId, {
      runnerHostname: "different-host.example.test",
    });
    await sourceHomeHeartbeat(f, f.receiverId, { snapshotSequence: 1 });
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await sourceHomeHeartbeat(f, f.receiverId);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "sourceHome",
      home: { evidence: "expected" },
    });
  });

  it("does not borrow another draining process's producer for the winning source", async () => {
    const f = await sourceHomeFixture(context);
    await sourceHomeHeartbeat(f, f.sourceId, {
      snapshotGeneration: 8,
      activeReuseProducers: [],
    });
    await sourceHomeHeartbeat(f, randomUUID(), {
      mode: "draining",
      activeReuseProducers: [
        { runId: f.source.runId, reuseKey: f.reuseKey, profile: "vm0/default" },
      ],
    });
    mockNow(f.clock + 2000);
    await sourceHomeContinuation(f);
    expect((await sourceHomePoll(f))?.runnerPreference).toMatchObject({
      tier: "sourceHome",
      home: { evidence: "location" },
    });
  });
});
