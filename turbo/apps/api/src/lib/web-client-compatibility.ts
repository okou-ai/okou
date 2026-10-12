import { z } from "zod";

import { APP_VERSION_PATTERN, compareAppVersions } from "./app-version";
import compatibilityConfig from "./web-client-compatibility.json";

const appVersionSchema = z.string().regex(APP_VERSION_PATTERN);

const webClientCompatibilityConfigSchema = z.object({
  minimumSupportedVersion: appVersionSchema,
});

// This floor is a rollout boundary: raise it only after the matching app build
// is live so older browser bundles receive 426 before removed routes are matched.
const { minimumSupportedVersion } =
  webClientCompatibilityConfigSchema.parse(compatibilityConfig);

export function isSupportedWebClientVersion(version: string): boolean {
  const comparison = compareAppVersions(version, minimumSupportedVersion);
  return comparison === null || comparison >= 0;
}
