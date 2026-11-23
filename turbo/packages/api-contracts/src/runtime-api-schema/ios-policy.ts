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

// Only a base commit may have the old single floor. It was backed by TestFlight.
function readBaseIosPolicy(value: unknown): IosCompatibilityPolicy {
  const legacy = legacyPolicy.safeParse(value);
  return iosCompatibilityPolicySchema.parse(
    legacy.success
      ? {
          appStoreMinimumSupportedVersion: null,
          testFlightMinimumSupportedVersion:
            legacy.data.minimumSupportedVersion,
          reviewCandidate: null,
        }
      : value,
  );
}

function above(left: string | null | undefined, right: string): boolean {
  if (left == null) return false;
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) throw new Error("Expected validated stable iOS versions");
  return compareVersions(a, b) > 0;
}

function sameBuild(
  candidate: NonNullable<IosCompatibilityPolicy["reviewCandidate"]>,
  other: IosCompatibilityPolicy["reviewCandidate"] | undefined,
): boolean {
  return (
    candidate.version === other?.version &&
    candidate.build === other.build &&
    candidate.commit === other.commit
  );
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

  const candidate = current.reviewCandidate;
  const previous = base.reviewCandidate;
  if (
    candidate &&
    !sameBuild(candidate, previous) &&
    !sameBuild(candidate, available.testflight)
  ) {
    errors.push(
      "Register the review candidate using the exact version, build and release commit of a verified TestFlight upload.",
    );
  }
  // Protect both builds in the PR that removes or replaces the previous lock.
  const reviewVersion = checkReviewCeilings(current, previous, errors);
  return {
    iosAppStoreFloor: {
      floor: store,
      baseFloor: base.appStoreMinimumSupportedVersion,
    },
    iosAppStorePublishedVersion: available["app-store"]?.publishedVersion,
    iosReviewVersion: reviewVersion,
    iosPolicyErrors: errors,
  };
}

function checkReviewCeilings(
  current: IosCompatibilityPolicy,
  previous: IosCompatibilityPolicy["reviewCandidate"],
  errors: string[],
) {
  let highest: string | undefined;
  for (const ceiling of new Set([
    previous?.version,
    current.reviewCandidate?.version,
  ])) {
    if (!ceiling) continue;
    if (
      above(current.appStoreMinimumSupportedVersion, ceiling) ||
      above(current.testFlightMinimumSupportedVersion, ceiling)
    ) {
      errors.push(
        `Neither iOS minimum may exceed review candidate ${ceiling}.`,
      );
    }
    if (!highest || above(ceiling, highest)) highest = ceiling;
  }
  return highest;
}
