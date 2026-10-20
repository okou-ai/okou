import { describe, expect, it } from "vitest";

import { jobSchema, runnersJobClaimContract } from "../runners";

const sourceRunId = "11111111-1111-4111-8111-111111111111";
const preference = {
  kind: "preference" as const,
  runnerIdentity: {
    runnerId: "22222222-2222-4222-8222-222222222222",
    heartbeatGeneration: 7,
  },
  tier: "finalizingPredecessor" as const,
  expiresAt: "2026-10-20T00:00:49.000Z",
};
const job = {
  runId: "33333333-3333-4333-8333-333333333333",
  prompt: "continue with another framework",
  appendSystemPrompt: null,
  vars: null,
  experimentalProfile: "vm0/default",
};

describe("independent finalizing source reader preparation", () => {
  it("preserves source identity without manufacturing native history", () => {
    const runnerPreference = {
      ...preference,
      finalizingSourceRunId: sourceRunId,
    };
    const parsed = jobSchema.parse({ ...job, runnerPreference });
    expect(parsed.runnerPreference).toStrictEqual(runnerPreference);
    expect(parsed.historyGenerationRunId).toBeUndefined();

    const telemetry = {
      runnerPreference,
      runnerPreferenceClaimState: "active",
    };
    expect(
      runnersJobClaimContract.claim.body.parse({
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
        telemetry,
      }).telemetry,
    ).toStrictEqual(telemetry);
  });

  it("keeps the old preference shape readable until writer retirement", () => {
    expect(
      jobSchema.parse({ ...job, runnerPreference: preference })
        .runnerPreference,
    ).toStrictEqual(preference);
  });

  it("rejects malformed source identity at the discovery boundary", () => {
    for (const finalizingSourceRunId of ["invalid", null]) {
      expect(
        jobSchema.safeParse({
          ...job,
          runnerPreference: { ...preference, finalizingSourceRunId },
        }).success,
      ).toBe(false);
    }
  });
});
