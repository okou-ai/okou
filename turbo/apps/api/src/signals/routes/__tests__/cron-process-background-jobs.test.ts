import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import {
  expectGlobalSweepMissingAuth,
  expectGlobalSweepWrongAuth,
} from "./helpers/global-sweep-contract";

const context = testContext();

describe("GET /api/cron/process-background-jobs", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-background-jobs-cron-secret");
  });

  it("rejects a missing cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepMissingAuth(
      context,
      cronProcessBackgroundJobsRoutes,
      cronProcessBackgroundJobsContract.process.path,
    );
  });

  it("rejects an invalid cron secret", async () => {
    expect.hasAssertions();
    await expectGlobalSweepWrongAuth(
      context,
      cronProcessBackgroundJobsRoutes,
      cronProcessBackgroundJobsContract.process.path,
    );
  });
});
