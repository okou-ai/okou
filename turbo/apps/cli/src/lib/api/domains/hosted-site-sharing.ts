import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  hostedSiteVisibilityStatusSchema,
  type HostedSiteVisibility,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  hostedSiteSharingContract,
  hostedSiteShareSchema,
} from "@okouai/api-contracts/contracts/hosted-site-sharing";
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
  const response = await client.siteVisibility({
    params: { siteId },
    fetchOptions: { cache: "no-store" },
  });
  if (response.status !== 200) {
    handleError(response, "Website visibility is not available");
  }
  const current = hostedSiteVisibilityStatusSchema.parse(response.body);
  if (current.siteId !== siteId) {
    throw new Error("The API returned visibility for a different website");
  }
  return current;
}

export async function updateHostedSiteVisibility(
  current: VisibilityStatus,
  visibility: HostedSiteVisibility,
) {
  const client = initClient(hostContract, await getClientConfig());
  const response = await client.updateSiteVisibility({
    params: { siteId: current.siteId },
    body: { visibility, expectedRevision: current.revision },
  });
  if (response.status !== 200) {
    handleError(response, "Could not update website visibility");
  }
  const saved = hostedSiteVisibilityStatusSchema.parse(response.body);
  if (saved.siteId !== current.siteId || saved.visibility !== visibility) {
    throw new Error(
      "The API did not confirm the requested website visibility. No email invitations were requested.",
    );
  }
  return saved;
}

export async function shareHostedSiteByEmail(
  siteId: string,
  email: string,
): Promise<HostedSiteShare> {
  const client = initClient(hostedSiteSharingContract, await getClientConfig());
  const response = await client.share({
    params: { siteId },
    body: { email },
  });
  if (response.status !== 200) {
    handleError(response, "Could not process the website sharing invitation");
  }
  const share = hostedSiteShareSchema.parse(response.body.share);
  if (share.email !== email) {
    throw new Error("The API did not confirm the requested invitation email");
  }
  return share;
}
