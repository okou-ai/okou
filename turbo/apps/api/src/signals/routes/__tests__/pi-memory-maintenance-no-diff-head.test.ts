import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  webhooks,
  prepareMaintenance,
  publish,
  completeMaintenance,
  observeMemory,
  publishOrdinaryMemory,
} = createPiMemoryMaintenanceFixture(context);

describe("Genuine Pi maintenance publication results", () => {
  it("replays a no-diff result without restoring an older memory head", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run);
    await webhooks.requestAgentStorageCommit(body, run.headers, [200]);
    await completeMaintenance(run, body.versionId);
    expect((await observeMemory(run)).memory.versionId).toBe(body.versionId);
    const newer = await publishOrdinaryMemory(run, "Newer ordinary memory.\n");
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
    expect(newer.versionId).not.toBe(body.versionId);
    expect(
      (await observeMemory(run, "Newer ordinary memory.\n")).memory.versionId,
    ).toBe(newer.versionId);
  });
});
