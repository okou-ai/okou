import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type { hostedSiteBannerStatusSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import type { infer as zInfer } from "zod";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

export async function getHostedSiteBanner(publicSlug: string) {
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
  const response = await client.siteBanner({
    params: { siteId: alias.body.pointer.siteId },
    fetchOptions: { cache: "no-store" },
  });
  if (response.status !== 200) {
    handleError(response, "Website settings are not available");
  }
  return response.body;
}

export async function updateHostedSiteBanner(
  current: zInfer<typeof hostedSiteBannerStatusSchema>,
  showBanner: boolean,
) {
  const client = initClient(hostContract, await getClientConfig());
  const response = await client.updateSiteBanner({
    params: { siteId: current.siteId },
    body: { showBanner, expectedRevision: current.revision },
  });
  if (response.status !== 200) {
    handleError(response, "Could not update website settings");
  }
  return response.body;
}
