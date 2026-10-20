import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
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
} = createPiMemoryMaintenanceFixture(context);

describe("Genuine Pi maintenance publication results", () => {
  it.each(["original", "recovery"])(
    "replays a completed maintenance Run's %s completion after a later maintenance replaces the latest Job result",
    async (kind) => {
      const run = await prepareMaintenance();
      const first = await publish(run, "First maintenance memory.\n");
      const completed = await completeMaintenance(run, first.versionId);
      const firstResult = await runs.readRun(run.actor, run.runId);
      expect(firstResult).toMatchObject({
        status: "completed",
        result: { storageOutputs: [{ version: first.versionId }] },
      });
      const { artifactSnapshots, ...metadata } = completed.body.completion;
      const canonicalReplay = {
        ...completed.body,
        completion: { ...metadata, storageOutputs: artifactSnapshots },
      };
      const recoveryReplay = {
        ...completed.body,
        completion: {
          ...metadata,
          storageOutputs: [
            {
              name: run.memory.name,
              mountPath: run.memory.mountPath,
              version: run.maintenance.claimedBaseVersionId,
            },
          ],
        },
      };

      // An ordinary owned HEAD change queues reconciliation immediately, within
      // the first claim's real three-hour credential lifetime and without waiting
      // for the six-hour successful-maintenance cooldown.
      const ordinary = await publishOrdinaryMemory(
        run,
        "Later maintenance memory.\n",
      );
      const dispatched = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(dispatched.body).toMatchObject({
        claimed: 1,
        failed: 0,
        stale: 0,
      });
      const next = await run.claimMaintenance();
      expect(next.runId).not.toBe(run.runId);
      expect(next.maintenance.claimedRevision).toBeGreaterThan(
        run.maintenance.claimedRevision,
      );
      expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
      const latest = await publish(next, "Later maintenance memory.\n");
      await completeMaintenance(next, latest.versionId);
      const latestResult = await runs.readRun(run.actor, next.runId);
      expect(latestResult).toMatchObject({
        status: "completed",
        result: { storageOutputs: [{ version: latest.versionId }] },
      });

      const replay = await webhooks.requestAgentComplete(
        kind === "original" ? canonicalReplay : recoveryReplay,
        run.headers,
        [200],
      );
      expect(replay.body).toStrictEqual(completed.response.body);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(completed.body, next.headers, [401]);
      const observations = await Promise.allSettled([
        expect(runs.readRun(run.actor, run.runId)).resolves.toStrictEqual(
          firstResult,
        ),
        expect(runs.readRun(run.actor, next.runId)).resolves.toStrictEqual(
          latestResult,
        ),
        observeMemory(run, "Later maintenance memory.\n").then(({ memory }) => {
          expect(memory.versionId).toBe(latest.versionId);
        }),
      ]);
      for (const observation of observations) {
        if (observation.status === "rejected") {
          throw observation.reason;
        }
      }
      const settled = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
    },
  );
});
