import { strictObject, string } from "zod";
import {
  iosBuildIdentitySchema,
  iosCompatibilityPolicySchema,
  type IosCompatibilityPolicy,
} from "../contracts/ios-client-compatibility";
import { compareVersions, parseStableVersion } from "./gate";

const legacyPolicy = strictObject({
  minimumSupportedVersion: string().nullable(),
});
const availabilitySchema = strictObject({
  "app-store": iosBuildIdentitySchema
    .extend({ publishedVersion: iosBuildIdentitySchema.shape.version })
    .optional(),
  testflight: iosBuildIdentitySchema.optional(),
});

// Protected base commits can still contain either historical policy format.
const baseChannelPolicy = iosCompatibilityPolicySchema.extend({
  reviewCandidate: iosBuildIdentitySchema.nullable().optional(),
});

function readBaseIosPolicy(value: unknown): IosCompatibilityPolicy {
  const legacy = legacyPolicy.safeParse(value);
  if (legacy.success) {
    return iosCompatibilityPolicySchema.parse({
      appStoreMinimumSupportedVersion: null,
      testFlightMinimumSupportedVersion: legacy.data.minimumSupportedVersion,
    });
  }
  return baseChannelPolicy.parse(value);
}

function above(left: string | null, right: string): boolean {
  if (left === null) return false;
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new Error("Expected validated stable iOS versions");
  return compareVersions(a, b) > 0;
}

export function iosGatePolicy(
  currentInput: unknown,
  baseInput: unknown,
  availabilityInput: unknown,
) {
  const current = iosCompatibilityPolicySchema.parse(currentInput);
  const base = readBaseIosPolicy(baseInput);
  const available = availabilitySchema.parse(availabilityInput);
  const errors: string[] = [];
  const store = current.appStoreMinimumSupportedVersion;
  const beta = current.testFlightMinimumSupportedVersion;

  if (
    store !== null &&
    store !== base.appStoreMinimumSupportedVersion &&
    store !== available["app-store"]?.version
  ) {
    errors.push(
      `App Store minimum ${store} needs public release verification for that exact marketing version.`,
    );
  }
  if (store !== null && (beta === null || above(store, beta))) {
    errors.push("TestFlight minimum must be at least the App Store minimum.");
  }
  if (beta !== base.testFlightMinimumSupportedVersion) {
    if (beta === null || above(base.testFlightMinimumSupportedVersion, beta)) {
      errors.push("The TestFlight minimum may only rise.");
    } else if (
      !available.testflight ||
      above(beta, available.testflight.version)
    ) {
      errors.push(
        `TestFlight minimum ${beta} needs a verified, currently installable TestFlight replacement.`,
      );
    }
  }

  return {
    iosAppStoreFloor: {
      floor: store,
      baseFloor: base.appStoreMinimumSupportedVersion,
    },
    iosAppStorePublishedVersion: available["app-store"]?.publishedVersion,
    iosPolicyErrors: errors,
  };
}
