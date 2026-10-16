import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const { runs, cronHeaders, prepareMaintenance } =
  createPiMemoryMaintenanceFixture(context);

test.each(["same-org", "same-user-other-org", "foreign"] as const)(
  "shows both claimed maintenance Runs to their owners with %s isolation",
  async (peerScope) => {
    const first = await prepareMaintenance({
      independentOwner: true,
      peerScope,
    });
    const dispatched = await accept(
      first.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0, stale: 0 });
    const second = await first.claimMaintenance(1);
    expect(second.runId).not.toBe(first.runId);
    expect(second.memory.storageId).not.toBe(first.memory.storageId);

    for (const run of [first, second]) {
      await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
        runId: run.runId,
        status: "running",
        source: { model: "okou-memory" },
      });
    }
  },
);
