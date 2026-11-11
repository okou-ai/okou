import type { AndroidUpgradeRequired } from "@okouai/api-contracts/contracts/android-client-compatibility";
import { object, string } from "zod";
import { compareAppVersions } from "./app-version";
import compatibilityConfig from "./android-client-compatibility.json";

const configSchema = object({
  minimumSupportedVersion: string()
    .regex(/^\d+\.\d+\.\d+$/u)
    .nullable(),
});
configSchema.parse(compatibilityConfig);

/** Source-controlled policy. Null until a verified, available Android release supports a floor. */
export function androidMinimumSupportedVersion(): string | null {
  return configSchema.parse(compatibilityConfig).minimumSupportedVersion;
}

export function isSupportedAndroidClientVersion(version: string): boolean {
  const floor = androidMinimumSupportedVersion();
  if (floor === null) return true;
  const comparison = compareAppVersions(version, floor);
  return comparison === null || comparison >= 0;
}

export function androidUpgradeRequired(
  minimumSupportedVersion: string,
): AndroidUpgradeRequired {
  return {
    error: {
      code: "ANDROID_UPDATE_REQUIRED",
      message: "Update Okou for Android to continue.",
    },
    minimumSupportedVersion,
  };
}
