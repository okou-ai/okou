import {
  iosCompatibilityPolicySchema,
  type IosCompatibilityPolicy,
  type IosUpgradeRequired,
} from "@okouai/api-contracts/contracts/ios-client-compatibility";
import { compareAppVersions } from "./app-version";
import configuration from "./ios-client-compatibility.json";

// Before channels were reported, requests below this floor were already blocked.
const legacyFloor = "0.51.12";
iosCompatibilityPolicySchema.parse(configuration);
const policy: IosCompatibilityPolicy = configuration;

export function iosDistribution(value: string | undefined) {
  if (value === undefined) {
    return "legacy";
  }
  if (value === "app-store" || value === "testflight") {
    return value;
  }
  return "unknown";
}

type IosDistribution = ReturnType<typeof iosDistribution>;

export function iosMinimumSupportedVersion(
  channel: IosDistribution,
): string | null {
  if (channel === "testflight") {
    return policy.testFlightMinimumSupportedVersion;
  }
  const storeFloor = policy.appStoreMinimumSupportedVersion;
  if (
    channel === "legacy" &&
    (storeFloor === null ||
      (compareAppVersions(storeFloor, legacyFloor) ?? 0) < 0)
  ) {
    return legacyFloor;
  }
  return storeFloor;
}

export function iosUpgradeRequired(
  minimumSupportedVersion: string,
  channel: IosDistribution,
): IosUpgradeRequired {
  let message = "Update Okou to continue.";
  if (
    channel === "testflight" ||
    (channel === "legacy" && policy.appStoreMinimumSupportedVersion === null)
  ) {
    message = "Update Okou in TestFlight to continue.";
  } else if (channel === "app-store") {
    message = "Update Okou in the App Store to continue.";
  }
  return {
    error: { code: "IOS_UPDATE_REQUIRED", message },
    minimumSupportedVersion,
  };
}
