import { describe, expect, it } from "vitest";

import {
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  piInstalledCliRequirementSchema,
  releaseVersionSchema,
  runnerInstalledVersionsSchema,
  runnersJobClaimContract,
} from "../runners";

describe("release versions", () => {
  it("accepts only MAJOR.MINOR.PATCH", () => {
    expect(releaseVersionSchema.safeParse("9.368.2").success).toBe(true);
    for (const invalid of ["9.368", "v9.368.2", "9.368.2-rc.1", "latest", ""]) {
      expect(releaseVersionSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      releaseVersionSchema.safeParse(PI_SANDBOX_INSTALLED_CLI_MIN_VERSION)
        .success,
    ).toBe(true);
  });
});

describe("Pi installed-CLI requirement", () => {
  const requirement = {
    requiredPiAgentRuntimeVersion: "1.36.0",
    minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
    requiredPiSessionConstructionDigest: "c".repeat(64),
  } as const;

  it("carries the exact runtime version, the CLI floor and the parity digest", () => {
    expect(piInstalledCliRequirementSchema.parse(requirement)).toStrictEqual(
      requirement,
    );
    expect(
      piInstalledCliRequirementSchema.safeParse({
        ...requirement,
        requiredPiAgentRuntimeVersion: "1.36",
      }).success,
    ).toBe(false);
    for (const invalid of ["C".repeat(64), "c".repeat(63), ""]) {
      expect(
        piInstalledCliRequirementSchema.safeParse({
          ...requirement,
          requiredPiSessionConstructionDigest: invalid,
        }).success,
      ).toBe(false);
    }
  });
});

describe("runner claim installed versions", () => {
  it("is an optional top-level claim body field", () => {
    const body = runnersJobClaimContract.claim.body;
    const capabilities = { piModelConfigGenerations: [1, 2, 3] };
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
    const advertised = runnerInstalledVersionsSchema.parse({
      cli: "9.353.0",
      piAgentRuntime: "1.36.0",
      piSdk: "0.86.1+okou.0123456789ab",
      piSessionConstructionDigest: "d".repeat(64),
    });
    expect(advertised.piSessionConstructionDigest).toBe("d".repeat(64));
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
