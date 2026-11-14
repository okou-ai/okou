import { describe, expect, it } from "vitest";
import { runnerPreferenceSchema } from "../runners";

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
  ])("preserves the direct routing source and wait policy: $tier", (input) => {
    expect(runnerPreferenceSchema.parse(input)).toStrictEqual(input);
  });

  it("rejects malformed predecessor identity in direct routing preferences", () => {
    for (const predecessorRunId of ["invalid", null]) {
      expect(
        runnerPreferenceSchema.safeParse({ ...preference, predecessorRunId })
          .success,
      ).toBe(false);
    }
  });
});
