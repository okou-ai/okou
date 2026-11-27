import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  artifactAccessContract,
  artifactVisibilityResponseSchema,
} from "@okouai/api-contracts/contracts/artifact-access";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  hostedSiteVisibilityStatusSchema,
  type HostedSiteVisibility,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { hostedSiteShareSchema } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import {
  featureSwitchesContract,
  featureSwitchesResponseSchema,
} from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { infer as zInfer } from "zod";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

export type HostedSiteShare = zInfer<typeof hostedSiteShareSchema>;
type VisibilityStatus = zInfer<typeof hostedSiteVisibilityStatusSchema>;

export async function assertHostedSiteEmailSharing(): Promise<void> {
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
  if (effectiveSwitches[FeatureSwitchKey.HostedSiteEmailSharing] !== true) {
    throw new Error(
      "Website email sharing is not enabled for this account and workspace. No website or sharing settings were changed.",
    );
  }
}

export async function getHostedSiteVisibility(publicSlug: string) {
  const client = initClient(hostContract, await getClientConfig());
  const alias = await client.resolveAlias({
    params: { publicSlug },
    query: { publicBrand: "okou" },
    fetchOptions: { cache: "no-store" },
  });
  if (alias.status !== 200) {
    handleError(alias, "Published website not found");
  }
  if (!alias.body.pointer) {
    throw new ApiRequestError("Published website not found", "NOT_FOUND", 404);
  }
  const { siteId } = alias.body.pointer;
  const accessClient = initClient(
    artifactAccessContract,
    await getClientConfig(),
  );
  const response = await accessClient.getVisibility({
    params: { artifactId: siteId },
    fetchOptions: { cache: "no-store" },
  });
  if (response.status !== 200) {
    handleError(response, "Website visibility is not available");
  }
  const parsed = artifactVisibilityResponseSchema.parse(response.body);
  return hostedSiteVisibilityStatusSchema.parse({
    siteId,
    visibility: parsed.visibility,
    revision: parsed.revision,
  });
}

export async function updateHostedSiteVisibility(
  current: VisibilityStatus,
  visibility: HostedSiteVisibility,
) {
  const accessClient = initClient(
    artifactAccessContract,
    await getClientConfig(),
  );
  const response = await accessClient.updateVisibility({
    params: { artifactId: current.siteId },
    body: { visibility, expectedRevision: current.revision },
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
  return hostedSiteVisibilityStatusSchema.parse({
    siteId: current.siteId,
    visibility: parsed.visibility,
    revision: parsed.revision,
  });
}

export async function shareHostedSiteByEmail(
  siteId: string,
  email: string,
): Promise<HostedSiteShare> {
  const accessClient = initClient(
    artifactAccessContract,
    await getClientConfig(),
  );
  const response = await accessClient.addShare({
    params: { artifactId: siteId },
    body: { email },
  });
  if (response.status !== 200) {
    handleError(response, "Could not process the website sharing invitation");
  }
  const share = hostedSiteShareSchema.parse({
    id: response.body.share.id,
    email: response.body.share.email,
  });
  if (share.email !== email) {
    throw new Error("The API did not confirm the requested invitation email");
  }
  return share;
}
