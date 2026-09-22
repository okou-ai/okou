import { describe, expect, it } from "vitest";

import {
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  piApiFirstTurnConfigSchema,
  releaseVersionSchema,
  runnerInstalledVersionsSchema,
  runnersJobClaimContract,
} from "../runners";

const API_FIRST_TURN = {
  schemaVersion: 1,
  resourceSnapshotDigest: "a".repeat(64),
  manifestUrl: "https://handoff.example/manifest.json",
  sessionUrl: "https://handoff.example/session.jsonl",
  deadlineAt: 5_000,
  baseSession: {
    sessionId: "11111111-1111-4111-8111-111111111111",
    sha256: null,
  },
  sandboxEventSequenceStart: 1,
} as const;

describe("release versions", () => {
  it("accepts only MAJOR.MINOR.PATCH", () => {
    expect(releaseVersionSchema.safeParse("9.352.7").success).toBe(true);
    for (const invalid of ["9.352", "v9.352.7", "9.352.7-rc.1", "latest", ""]) {
      expect(releaseVersionSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      releaseVersionSchema.safeParse(PI_SANDBOX_INSTALLED_CLI_MIN_VERSION)
        .success,
    ).toBe(true);
  });
});

describe("Pi API first-turn runtime requirements", () => {
  it("stays optional for launch configs captured before versioned artifacts", () => {
    expect(piApiFirstTurnConfigSchema.safeParse(API_FIRST_TURN).success).toBe(
      true,
    );
  });

  it("carries the exact runtime version and the CLI floor", () => {
    const parsed = piApiFirstTurnConfigSchema.parse({
      ...API_FIRST_TURN,
      requiredPiAgentRuntimeVersion: "1.36.0",
      minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
    });
    expect(parsed.requiredPiAgentRuntimeVersion).toBe("1.36.0");
    expect(parsed.minCliVersion).toBe(PI_SANDBOX_INSTALLED_CLI_MIN_VERSION);
    expect(
      piApiFirstTurnConfigSchema.safeParse({
        ...API_FIRST_TURN,
        requiredPiAgentRuntimeVersion: "1.36",
      }).success,
    ).toBe(false);
  });
});

describe("runner claim installed versions", () => {
  it("is an optional top-level claim body field", () => {
    const body = runnersJobClaimContract.claim.body;
    const capabilities = { piModelConfigGenerations: [1, 2, 3, 4] };
    expect(body.safeParse({ capabilities }).success).toBe(true);
    const parsed = body.parse({
      capabilities,
      installedVersions: {
        cli: "9.353.0",
        piAgentRuntime: "1.36.0",
        piSdk: "0.86.1+okou.0123456789ab",
      },
    });
    expect(parsed.installedVersions).toStrictEqual({
      cli: "9.353.0",
      piAgentRuntime: "1.36.0",
      piSdk: "0.86.1+okou.0123456789ab",
    });
  });

  it("rejects unknown fields and loose versions", () => {
    expect(
      runnerInstalledVersionsSchema.safeParse({
        cli: "9.353.0",
        piAgentRuntime: "1.36.0",
        piSdk: "0.86.1+okou.0123456789ab",
        commitSha: "abc",
      }).success,
    ).toBe(false);
    expect(
      runnerInstalledVersionsSchema.safeParse({
        cli: "9.353",
        piAgentRuntime: "1.36.0",
        piSdk: "0.86.1",
      }).success,
    ).toBe(false);
  });
});
