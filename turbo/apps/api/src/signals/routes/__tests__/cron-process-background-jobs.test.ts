import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createApp } from "../../../app-factory";
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

  it("fails closed when source-only preparation has no delivery configuration", async () => {
    mockEnv("MARKETING_REWARDS_EVENTS_ORIGIN", undefined);
    mockEnv("MARKETING_REWARDS_EVENTS_SECRET", undefined);
    const response = await createApp({
      signal: context.signal,
      routes: cronProcessBackgroundJobsRoutes,
    }).request(
      "/api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=25",
      { headers: { authorization: "Bearer test-background-jobs-cron-secret" } },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "EVENT_DELIVERY_UNAVAILABLE" },
    });
  });

  it("rejects a preparation batch above its fixed bound", async () => {
    const response = await createApp({
      signal: context.signal,
      routes: cronProcessBackgroundJobsRoutes,
    }).request(
      "/api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=101",
      { headers: { authorization: "Bearer test-background-jobs-cron-secret" } },
    );
    expect(response.status).toBe(400);
  });
});
