import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  webhooks,
  cronHeaders,
  prepareMaintenance,
  publish,
  completeMaintenance,
  observeMemory,
} = createPiMemoryMaintenanceFixture(context);

describe("Genuine Pi maintenance publication results", () => {
  it.each(["no-diff", "published"])(
    "publishes and replays a %s maintenance result before private completion",
    async (outcome) => {
      const run = await prepareMaintenance();
      const body = await publish(
        run,
        outcome === "published"
          ? "Prefer focused public API tests.\n"
          : undefined,
      );
      const replay = await webhooks.requestAgentStorageCommit(
        body,
        run.headers,
        [200],
      );
      expect(replay.body).toMatchObject({
        versionId: body.versionId,
        deduplicated: true,
      });
    },
  );

  it("replays a maintenance result after private completion", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run, "Prefer focused public API tests.\n");
    const completed = await completeMaintenance(run, body.versionId, true);
    const recovered = await webhooks.requestAgentComplete(
      {
        ...completed.body,
        completion: {
          ...completed.body.completion,
          storageOutputs: [
            {
              name: run.memory.name,
              mountPath: run.memory.mountPath,
              version: run.maintenance.claimedBaseVersionId,
            },
          ],
        },
      },
      run.headers,
      [200],
    );
    expect(recovered.body).toStrictEqual(completed.response.body);
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
    expect(
      (await observeMemory(run, "Prefer focused public API tests.\n")).memory,
    ).toMatchObject({
      storageId: body.storageId,
      versionId: body.versionId,
      archiveUrl: expect.any(String),
    });
    const settled = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
  });
});
