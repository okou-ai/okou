import { describe, expect, it } from "vitest";

import {
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
