import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import {
  PEER_HOSTNAME,
  peerContinuation,
  peerFinalizingFixture,
  peerHeartbeat,
  peerPoll,
} from "./helpers/peer-finalizing-fixture";

const context = testContext();

describe("peer finalizing evidence", () => {
  it("requires the winning source claim's hostname as well as matching heartbeats", async () => {
    const f = await peerFinalizingFixture(context, { claimHostname: null });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });

  it.each(["source", "receiver"] as const)(
    "rejects an accepted PAT %s snapshot even when it supplies the hostname",
    async (role) => {
      const f = await peerFinalizingFixture(context);
      const pat = await f.owned.run(() => {
        return f.api.createCliToken(f.owned.actor);
      });
      await f.owned.run(() => {
        return f.api.requestHeartbeatRunnerAs(`Bearer ${pat.token}`, [200], {
          runnerId: role === "source" ? f.sourceId : f.receiverId,
          runnerHostname: PEER_HOSTNAME,
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
      await peerContinuation(f);
      expect((await peerPoll(f))?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );

  it.each(["source", "receiver"] as const)(
    "rejects stale %s state independently of the other fresh process",
    async (role) => {
      const f = await peerFinalizingFixture(context);
      mockNow(f.clock + 30_001);
      await peerHeartbeat(f, role === "source" ? f.receiverId : f.sourceId);
      await peerContinuation(f);
      expect((await peerPoll(f))?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );

  it.each(["run", "reuseKey", "profile"] as const)(
    "does not earn a post-bridge window from the wrong producer %s",
    async (field) => {
      const f = await peerFinalizingFixture(context);
      await peerHeartbeat(f, f.sourceId, {
        activeReuseProducers: [
          {
            runId: field === "run" ? randomUUID() : f.source.runId,
            reuseKey: field === "reuseKey" ? "thread:unrelated" : f.reuseKey,
            profile: field === "profile" ? "vm0/other" : "vm0/default",
          },
        ],
      });
      mockNow(f.clock + 2000);
      await peerContinuation(f);
      expect((await peerPoll(f))?.runnerPreference).toMatchObject({
        kind: "noPreference",
      });
    },
  );

  it("does not let a stale hostname heartbeat undo a newer accepted snapshot", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.receiverId, {
      runnerHostname: "different-host.example.test",
    });
    await peerHeartbeat(f, f.receiverId, { snapshotSequence: 1 });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
    await peerHeartbeat(f, f.receiverId);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      tier: "peerFinalizingPredecessor",
    });
  });

  it("does not borrow another draining process's producer for the winning source", async () => {
    const f = await peerFinalizingFixture(context);
    await peerHeartbeat(f, f.sourceId, { mode: "starting" });
    await peerHeartbeat(f, randomUUID(), {
      mode: "draining",
      activeReuseProducers: [
        { runId: f.source.runId, reuseKey: f.reuseKey, profile: "vm0/default" },
      ],
    });
    await peerContinuation(f);
    expect((await peerPoll(f))?.runnerPreference).toMatchObject({
      kind: "noPreference",
    });
  });
});
