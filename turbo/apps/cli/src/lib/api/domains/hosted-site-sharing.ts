import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  artifactAccessContract,
  artifactUserShareEntrySchema,
  artifactVisibilityResponseSchema,
  type ArtifactUserShareEntry,
  type ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  featureSwitchesContract,
  featureSwitchesResponseSchema,
} from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

export type HostedSiteShare = ArtifactUserShareEntry;

export interface HostedSiteVisibilityStatus {
  readonly siteId: string;
  readonly artifactId: string;
  readonly visibility: ArtifactVisibilityValue;
}

export async function assertArtifactUserSharing(): Promise<void> {
  const client = initClient(featureSwitchesContract, await getClientConfig());
  const response = await client.get({
    fetchOptions: { cache: "no-store" },
  });
  if (response.status !== 200) {
    handleError(response, "Could not check website email sharing availability");
  }
  const { effectiveSwitches } = featureSwitchesResponseSchema.parse(
    response.body,
  );
  if (effectiveSwitches[FeatureSwitchKey.ArtifactUserSharing] !== true) {
    throw new Error(
      "Website email sharing is not enabled for this account and workspace. No website or sharing settings were changed.",
    );
  }
}

export async function getHostedSiteVisibility(
  publicSlug: string,
): Promise<HostedSiteVisibilityStatus> {
  const client = initClient(hostContract, await getClientConfig());
  const site = await client.siteUrl({
    params: { publicSlug },
    query: {},
    fetchOptions: { cache: "no-store" },
  });
  if (site.status !== 200) {
    handleError(site, "Published website not found");
  }
  const { siteId, artifactId } = site.body;
  if (!artifactId) {
    throw new ApiRequestError(
      "Website visibility is not available",
      "NOT_FOUND",
      404,
    );
  }
  const accessClient = initClient(
    artifactAccessContract,
    await getClientConfig(),
  );
  const response = await accessClient.getVisibility({
    params: { artifactId },
    fetchOptions: { cache: "no-store" },
  });
  if (response.status !== 200) {
    handleError(response, "Website visibility is not available");
  }
  const parsed = artifactVisibilityResponseSchema.parse(response.body);
  return {
    siteId,
    artifactId: parsed.artifactId,
    visibility: parsed.visibility,
  };
}

export async function updateHostedSiteVisibility(
  current: HostedSiteVisibilityStatus,
  visibility: ArtifactVisibilityValue,
): Promise<HostedSiteVisibilityStatus> {
  const accessClient = initClient(
    artifactAccessContract,
    await getClientConfig(),
  );
  const response = await accessClient.updateVisibility({
    params: { artifactId: current.artifactId },
    body: { visibility },
  });
  if (response.status !== 200) {
    handleError(response, "Could not update website visibility");
  }
  const parsed = artifactVisibilityResponseSchema.parse(response.body);
  if (parsed.visibility !== visibility) {
    throw new Error(
      "The API did not confirm the requested website visibility. No email invitations were requested.",
    );
  }
  return {
    siteId: current.siteId,
    artifactId: parsed.artifactId,
    visibility: parsed.visibility,
  };
}

export async function shareHostedSiteByEmail(
  artifactId: string,
  email: string,
): Promise<HostedSiteShare> {
  const accessClient = initClient(
    artifactAccessContract,
    await getClientConfig(),
  );
  const response = await accessClient.addShare({
    params: { artifactId },
    body: { email },
  });
  if (response.status !== 200) {
    handleError(response, "Could not process the website sharing invitation");
  }
  const share = artifactUserShareEntrySchema.parse(response.body.share);
  if (share.email !== email) {
    throw new Error("The API did not confirm the requested invitation email");
  }
  return share;
}
