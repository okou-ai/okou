import { describe, expect, it } from "vitest";

import {
  runnerApiUsageContract,
  runnerApiUsageResponseSchema,
} from "../runner-api-usage";

const runId = "00000000-0000-4000-8000-000000000001";

describe("runner API usage contract", () => {
  it("accepts coherent cumulative snapshots", () => {
    expect(
      runnerApiUsageResponseSchema.parse({
        state: "available",
        runId,
        revision: 2,
        sampledAtMs: 3,
        updatedAtMs: 2,
        inferenceState: "attempted",
        observedAttempts: 1,
        outstandingAttempts: 0,
        complete: true,
        reasons: [],
        totals: {
          input: 1,
          cacheRead: 2,
          cacheCreation: 3,
          output: 4,
          total: 10,
        },
      }),
    ).toMatchObject({ state: "available", revision: 2 });
  });

  it("rejects incoherent totals, reasons, quantities, and injected authority", () => {
    const base = {
      state: "available" as const,
      runId,
      revision: 1,
      sampledAtMs: 3,
      updatedAtMs: 2,
      inferenceState: "pending" as const,
      observedAttempts: 0,
      outstandingAttempts: 0,
      complete: false,
      reasons: ["pending_inference"] as const,
      totals: { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, total: 0 },
    };
    for (const value of [
      { ...base, totals: { ...base.totals, total: 1 } },
      { ...base, complete: true },
      { ...base, reasons: ["pending_inference", "pending_inference"] },
      {
        ...base,
        reasons: ["missing_usage", "pending_inference"],
      },
      { ...base, revision: 0 },
      { ...base, sampledAtMs: 0 },
      { ...base, observedAttempts: 9 },
      { ...base, totals: { ...base.totals, input: -1, total: -1 } },
    ]) {
      expect(runnerApiUsageResponseSchema.safeParse(value).success).toBe(false);
    }
    expect(
      runnerApiUsageContract.read.body.safeParse({
        runnerIdentity: {
          runnerId: runId,
          heartbeatGeneration: 1,
        },
        userId: "attacker",
      }).success,
    ).toBe(false);
    expect(
      runnerApiUsageContract.read.body.safeParse({
        runnerIdentity: {
          runnerId: "not-a-uuid",
          heartbeatGeneration: 0,
        },
      }).success,
    ).toBe(false);
  });
});
