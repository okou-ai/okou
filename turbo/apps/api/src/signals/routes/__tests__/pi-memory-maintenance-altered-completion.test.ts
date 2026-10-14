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
    await publishOrdinaryMemory(run, "Queue a later maintenance.\n");
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
    await Promise.all(
      [
        { ...completed.body.completion, cliAgentSessionId: next.runId },
        { ...completed.body.completion, cliAgentType: "claude-code" },
        {
          ...completed.body.completion,
          cliAgentSessionHistoryDisposition: "discarded_oversized" as const,
        },
        {
          ...completed.body.completion,
          artifactSnapshots: [
            {
              name: run.memory.name,
              mountPath: run.memory.mountPath,
              version: latest.versionId,
            },
          ],
        },
        { ...completed.body.completion, artifactSnapshots: [] },
        {
          ...completed.body.completion,
          artifactSnapshots: [
            ...completed.body.completion.artifactSnapshots,
            ...completed.body.completion.artifactSnapshots,
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
  });
});
