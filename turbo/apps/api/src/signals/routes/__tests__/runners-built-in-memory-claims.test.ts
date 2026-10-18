import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const { runs, cronHeaders, prepareSources, publish, completeMaintenance } =
  createPiMemoryMaintenanceFixture(context);

describe("Internal built-in memory claim authorization", () => {
  it("denies a user PAT without consuming the fixed private maintenance job", async () => {
    const sources = await prepareSources();
    const extracted = await accept(
      sources.stage1.extract({ headers: cronHeaders() }),
      [200],
    );
    expect(extracted.body).toMatchObject({ succeeded: 1 });
    const dispatched = await accept(
      sources.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0 });
    await sources.heartbeatRunner();
    const polled = await runs.pollRunner(sources.runnerGroup);
    const job = polled.body.job;
    if (!job) {
      throw new Error("Expected the genuine queued maintenance job");
    }
    const pat = await runs.createCliToken(sources.actor);
    const denied = await runs.requestClaimRunnerJobAs(
      `Bearer ${pat.token}`,
      job.runId,
      [403],
      { runnerIdentity: sources.runnerIdentity },
    );
    expect(denied.body).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Built-in model jobs require an official runner",
      },
    });
    const queued = await runs.pollRunner(sources.runnerGroup);
    expect(queued.body.job?.runId).toBe(job.runId);

    const run = { ...sources, ...(await sources.claimMaintenance()) };
    expect(run.runId).toBe(job.runId);
    expect(run.claim).toMatchObject({
      cliAgentType: "pi",
      piModelConfig: {
        provider: "openrouter",
        dialect: "openai-completions",
        model: "@preset/memory",
        catalogModel: "okou-memory",
      },
    });
    const publication = await publish(
      run,
      "Memory published by the authorized maintenance job.\n",
    );
    await completeMaintenance(run, publication.versionId);
    await runs.requestClaimRunnerJob(true, job.runId, [404]);
  });
});
