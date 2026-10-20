import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
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
  it("rejects altered completion after a later maintenance replaces the latest Job result", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run);
    const completed = await completeMaintenance(run, first.versionId);
    const firstResult = await runs.readRun(run.actor, run.runId);
    expect(firstResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: first.versionId }] },
    });
    await publishOrdinaryMemory(run, "Later maintenance memory.\n");
    const dispatched = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0 });
    const next = await run.claimMaintenance();
    const latest = await publish(next, "Later maintenance memory.\n");
    await completeMaintenance(next, latest.versionId);
    const latestResult = await runs.readRun(run.actor, next.runId);
    expect(latestResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: latest.versionId }] },
    });
    const rejectedCompletions = await Promise.allSettled(
      [
        { ...completed.body.completion, cliAgentSessionId: next.runId },
        { ...completed.body.completion, cliAgentType: "claude-code" },
        {
          ...completed.body.completion,
          storageOutputs: [
            {
              name: run.memory.name,
              mountPath: run.memory.mountPath,
              version: latest.versionId,
            },
          ],
        },
        { ...completed.body.completion, storageOutputs: [] },
        {
          ...completed.body.completion,
          storageOutputs: [
            ...completed.body.completion.storageOutputs,
            ...completed.body.completion.storageOutputs,
          ],
        },
      ].map((completion) => {
        return webhooks.requestAgentComplete(
          { ...completed.body, completion },
          run.headers,
          [400],
        );
      }),
    );
    for (const completion of rejectedCompletions) {
      if (completion.status === "rejected") {
        throw completion.reason;
      }
    }
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
  });
});
