import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  runs,
  webhooks,
  cronHeaders,
  prepareMaintenance,
  publish,
  completeMaintenance,
  observeMemory,
  publishOrdinaryMemory,
  expectBlocked,
} = createPiMemoryMaintenanceFixture(context);

describe("Serial private Pi maintenance", () => {
  it("renews an unpublished live attempt without launching another Run", async () => {
    const run = await prepareMaintenance();
    const renewed = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(renewed.body).toMatchObject({ claimed: 1, failed: 0 });
    const pending = await runs.pollRunner(run.runnerGroup);
    expect(pending.body.job).toBeNull();
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
    await publish(run);
  });

  it("renews one live attempt without starving another owner's claimable memory", async () => {
    const run = await prepareMaintenance({ independentOwner: true });
    const admitted = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(admitted.body).toMatchObject({ claimed: 1, failed: 0 });
    const independent = await run.claimMaintenance(1);
    expect(independent.actor.userId).not.toBe(run.actor.userId);
    expect(independent.memory.storageId).not.toBe(run.memory.storageId);
    const output = await publish(independent);
    await completeMaintenance(independent, output.versionId);
    await expect(
      runs.readRun(independent.actor, independent.runId),
    ).resolves.toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: output.versionId }] },
    });
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
  });

  it.each(["published", "no-diff"])(
    "retains an active %s result while an independent owner progresses",
    async (outcome) => {
      const run = await prepareMaintenance({ independentOwner: true });
      const first = await publish(
        run,
        outcome === "published" ? "First serial memory.\n" : undefined,
      );
      const admitted = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(admitted.body).toMatchObject({ claimed: 1, failed: 0 });
      const independent = await run.claimMaintenance(1);
      expect(independent.actor.userId).not.toBe(run.actor.userId);
      expect(independent.memory.storageId).not.toBe(run.memory.storageId);
      const independentOutput = await publish(
        independent,
        "Independent owner's memory.\n",
      );
      await completeMaintenance(independent, independentOutput.versionId);
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
      await completeMaintenance(
        run,
        run.maintenance.claimedBaseVersionId,
        true,
      );
      await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
        status: "completed",
        result: { storageOutputs: [{ version: first.versionId }] },
      });
    },
  );

  // Credential expiry is checked before the publication result is inspected.
  it.each([
    { outcome: "published", phase: "active replay" },
    { outcome: "no-diff", phase: "active replay" },
    { outcome: "published", phase: "finalized replay" },
    { outcome: "no-diff", phase: "finalized replay" },
    { outcome: "published", phase: "expired authority" },
  ])(
    "keeps the $outcome result consistent during $phase",
    async ({ outcome, phase }) => {
      const run = await prepareMaintenance();
      const first = await publish(
        run,
        outcome === "published" ? "First serial memory.\n" : undefined,
      );
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
      if (phase === "expired authority") {
        const completed = await completeMaintenance(
          run,
          run.maintenance.claimedBaseVersionId,
          true,
        );
        mockNow(now() + 3 * 60 * 60 * 1000 + 1000);
        await webhooks.requestAgentComplete(completed.body, run.headers, [401]);
        await webhooks.requestAgentComplete(
          {
            ...completed.body,
            completion: {
              ...completed.body.completion,
              storageOutputs: [
                {
                  name: run.memory.name,
                  mountPath: run.memory.mountPath,
                  version: first.versionId,
                },
              ],
            },
          },
          run.headers,
          [401],
        );
        return;
      }
      await publishOrdinaryMemory(run, "First queued owned update.\n", 1);
      const ordinary = await publishOrdinaryMemory(
        run,
        "Latest queued owned update.\n",
        1,
      );
      await expectBlocked(run);
      if (phase === "active replay") {
        const prepared = await webhooks.requestAgentStoragePrepare(
          first,
          run.headers,
          [200],
        );
        expect(prepared.body).toMatchObject({
          versionId: first.versionId,
          existing: true,
        });
        const activeReplay = await webhooks.requestAgentStorageCommit(
          first,
          run.headers,
          [200],
        );
        expect(activeReplay.body).toMatchObject({
          versionId: first.versionId,
          deduplicated: true,
        });
        return;
      }
      const completed = await completeMaintenance(
        run,
        run.maintenance.claimedBaseVersionId,
        true,
      );
      const original = await runs.readRun(run.actor, run.runId);
      expect(original).toMatchObject({
        status: "completed",
        result: { storageOutputs: [{ version: first.versionId }] },
      });
      const admitted = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(admitted.body).toMatchObject({ claimed: 1, failed: 0 });
      const next = await run.claimMaintenance();
      expect(next.actor.userId).toBe(run.actor.userId);
      expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
      expect(next.maintenance.claimedRevision).toBeGreaterThan(
        run.maintenance.claimedRevision,
      );
      const later = await publish(next, "Later serial maintenance memory.\n");
      await completeMaintenance(next, later.versionId);
      await webhooks.requestAgentComplete(completed.body, run.headers, [200]);
      await webhooks.requestAgentStorageCommit(first, run.headers, [200]);
      await webhooks.requestAgentComplete(completed.body, next.headers, [401]);
      await expect(runs.readRun(run.actor, run.runId)).resolves.toStrictEqual(
        original,
      );
      expect(
        (await observeMemory(run, "Later serial maintenance memory.\n")).memory
          .versionId,
      ).toBe(later.versionId);
    },
  );
});
