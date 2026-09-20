import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";

/** Historical selectors are metadata; deployment IDs identify publications. */
export function legacyHostedDeploymentVersion(
  manifest: HostedSiteManifest,
): number | null {
  return manifest.deploymentVersion ?? null;
}

export function legacyPrivateHostedDeploymentVersion(
  manifest: HostedSiteManifest,
): number {
  const version = legacyHostedDeploymentVersion(manifest);
  if (version === null) {
    throw new Error("Private hosted deployment has no legacy version metadata");
  }
  return version;
}
