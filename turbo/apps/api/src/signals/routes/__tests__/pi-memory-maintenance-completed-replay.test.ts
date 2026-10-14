import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
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
  it("replays a completed maintenance Run after a later maintenance replaces the latest Job result", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run, "First maintenance memory.\n");
    const completed = await completeMaintenance(run, first.versionId, true);
    const firstResult = await runs.readRun(run.actor, run.runId);
    expect(firstResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: first.versionId }] },
    });
    const recoveryReplay = {
      ...completed.body,
      completion: {
        ...completed.body.completion,
        artifactSnapshots: [
          {
            name: run.memory.name,
            mountPath: run.memory.mountPath,
            version: run.maintenance.claimedBaseVersionId,
          },
        ],
      },
    };
    await webhooks.requestAgentComplete(recoveryReplay, run.headers, [200]);

    // An ordinary owned HEAD change queues reconciliation immediately, within
    // the first claim's real three-hour credential lifetime and without waiting
    // for the six-hour successful-maintenance cooldown.
    const ordinary = await publishOrdinaryMemory(
      run,
      "Ordinary changed memory.\n",
    );
    const dispatched = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0, stale: 0 });
    const next = await run.claimMaintenance();
    expect(next.runId).not.toBe(run.runId);
    expect(next.maintenance.claimedRevision).toBeGreaterThan(
      run.maintenance.claimedRevision,
    );
    expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
    const latest = await publish(next, "Later maintenance memory.\n");
    await completeMaintenance(next, latest.versionId, true);
    const latestResult = await runs.readRun(run.actor, next.runId);
    expect(latestResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: latest.versionId }] },
    });

    const replay = await webhooks.requestAgentComplete(
      completed.body,
      run.headers,
      [200],
    );
    expect(replay.body).toStrictEqual(completed.response.body);
    const recovered = await webhooks.requestAgentComplete(
      recoveryReplay,
      run.headers,
      [200],
    );
    expect(recovered.body).toStrictEqual(completed.response.body);
    await flushWaitUntilForTest();
    await webhooks.requestAgentComplete(completed.body, next.headers, [401]);
    await expect(runs.readRun(run.actor, run.runId)).resolves.toStrictEqual(
      firstResult,
    );
    await expect(runs.readRun(run.actor, next.runId)).resolves.toStrictEqual(
      latestResult,
    );
    expect(
      (await observeMemory(run, "Later maintenance memory.\n")).memory
        .versionId,
    ).toBe(latest.versionId);
    const settled = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
    // Advancing the same case clock expires the original genuine credential.
    mockNow(now() + 3 * 60 * 60 * 1000 + 1000);
    await webhooks.requestAgentComplete(completed.body, run.headers, [401]);
  });
});
