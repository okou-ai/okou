import { z } from "zod";

import { compareAppVersions } from "./app-version";
import compatibilityConfig from "./ios-client-compatibility.json";

const iosClientCompatibilityConfigSchema = z.object({
  minimumSupportedVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/u, "The iOS floor must be a stable x.y.z version")
    .nullable(),
});

iosClientCompatibilityConfigSchema.parse(compatibilityConfig);

// Global source-controlled policy; changes require a PR and an API release.
// Never configure it through CI, GitHub Environments, Vercel variables, or
// per-user overrides, and never derive it from the web floor. Keep null until
// the header-sending iOS build is on TestFlight and request logs show adoption.
export function iosMinimumSupportedVersion(): string | null {
  return iosClientCompatibilityConfigSchema.parse(compatibilityConfig)
    .minimumSupportedVersion;
}

export function isSupportedIosClientVersion(version: string): boolean {
  const minimumSupportedVersion = iosMinimumSupportedVersion();
  if (minimumSupportedVersion === null) {
    return true;
  }
  const comparison = compareAppVersions(version, minimumSupportedVersion);
  return comparison === null || comparison >= 0;
}

export function iosUpgradeRequired(minimumSupportedVersion: string) {
  return {
    error: {
      code: "IOS_UPDATE_REQUIRED" as const,
      message: "Update Okou in TestFlight to continue.",
    },
    minimumSupportedVersion,
  };
}
