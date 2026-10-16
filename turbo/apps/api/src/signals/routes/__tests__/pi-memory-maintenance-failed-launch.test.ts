import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const { runs, cronHeaders, prepareSources } =
  createPiMemoryMaintenanceFixture(context);

describe("Pi maintenance launch preparation failure", () => {
  it("retains unfinished failed history after the retry window without dispatching a Runner job", async () => {
    const sources = await prepareSources();
    const extracted = await accept(
      sources.stage1.extract({ headers: cronHeaders() }),
      [200],
    );
    expect(extracted.body).toMatchObject({
      success: true,
      succeeded: 1,
      terminalFailure: 0,
      retryableFailure: 0,
    });

    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const failed = await accept(
      sources.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(failed.body).toMatchObject({
      success: true,
      claimed: 1,
      failed: 1,
      stale: 0,
    });
    await sources.heartbeatRunner();
    expect((await runs.pollRunner(sources.runnerGroup)).body.job).toBeNull();

    mockOptionalEnv("RUNNER_DEFAULT_GROUP", sources.runnerGroup);
    const waiting = await accept(
      sources.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(waiting.body).toMatchObject({ claimed: 0, noWork: 1, failed: 0 });

    // A SQL failure also increments the failed counter. The genuine failed
    // Run/callback history additionally suppresses claims after the retry is due.
    mockNow(now() + 61 * 60 * 1000);
    const blocked = await accept(
      sources.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(blocked.body).toMatchObject({ claimed: 0, noWork: 1, failed: 0 });
    await sources.heartbeatRunner();
    expect((await runs.pollRunner(sources.runnerGroup)).body.job).toBeNull();
  });
});
