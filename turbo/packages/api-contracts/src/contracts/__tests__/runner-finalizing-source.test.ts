import { describe, expect, it } from "vitest";

import { jobSchema, runnersJobClaimContract } from "../runners";

const predecessorRunId = "11111111-1111-4111-8111-111111111111";
const preference = {
  kind: "preference" as const,
  runnerIdentity: {
    runnerId: "22222222-2222-4222-8222-222222222222",
    heartbeatGeneration: 7,
  },
  tier: "finalizingPredecessor" as const,
  expiresAt: "2026-10-20T00:00:49.000Z",
  predecessorRunId,
};
const job = {
  runId: "33333333-3333-4333-8333-333333333333",
  prompt: "continue with another framework",
  appendSystemPrompt: null,
  vars: null,
  experimentalProfile: "vm0/default",
};

describe("independent predecessor preference contract", () => {
  it.each([
    preference,
    ...[
      { evidence: "advertised" },
      { evidence: "location" },
      { evidence: "expected", homeWaitUntil: "2026-10-20T00:00:49.000Z" },
    ].map((home) => {
      return {
        kind: "preference",
        runnerIdentity: preference.runnerIdentity,
        tier: "predecessorHome",
        predecessorRunId,
        expiresAt: "2026-10-20T00:00:02.000Z",
        home,
      };
    }),
  ])(
    "preserves source and independent wait policy without native history: $tier",
    (runnerPreference) => {
      const parsed = jobSchema.parse({ ...job, runnerPreference });
      expect(parsed.runnerPreference).toStrictEqual(runnerPreference);
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
    },
  );

  it("rejects malformed predecessor identity at the discovery boundary", () => {
    for (const predecessorRunId of ["invalid", null]) {
      expect(
        jobSchema.safeParse({
          ...job,
          runnerPreference: { ...preference, predecessorRunId },
        }).success,
      ).toBe(false);
    }
  });
});
