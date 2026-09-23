import { z } from "zod";

import compatibilityConfig from "./web-client-compatibility.json";

type AppVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
};

const APP_VERSION_PATTERN =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

const appVersionSchema = z.string().regex(APP_VERSION_PATTERN);

const webClientCompatibilityConfigSchema = z.object({
  minimumSupportedVersion: appVersionSchema,
});

// This floor is a rollout boundary: raise it only after the matching app build
// is live so older browser bundles receive 426 before removed routes are matched.
const { minimumSupportedVersion } =
  webClientCompatibilityConfigSchema.parse(compatibilityConfig);

function parseAppVersion(version: string): AppVersion | null {
  const match = APP_VERSION_PATTERN.exec(version);
  if (!match?.groups) {
    return null;
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

function compareAppVersions(left: string, right: string): number | null {
  const parsedLeft = parseAppVersion(left);
  const parsedRight = parseAppVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }

  const releaseComparison =
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch;
  if (releaseComparison !== 0) {
    return releaseComparison;
  }

  if (parsedLeft.prerelease.length === 0) {
    return parsedRight.prerelease.length === 0 ? 0 : 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }

    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function isSupportedWebClientVersion(version: string): boolean {
  const comparison = compareAppVersions(version, minimumSupportedVersion);
  return comparison === null || comparison >= 0;
}
