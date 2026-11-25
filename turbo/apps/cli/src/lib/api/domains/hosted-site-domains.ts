import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  hostedDomainSettingsSchema,
  type hostedDomainSchema,
} from "@okouai/api-contracts/contracts/hosted-site-domains";
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

export type HostedSiteDomainSettings = zInfer<
  typeof hostedDomainSettingsSchema
>;
export type HostedSiteDomain = zInfer<typeof hostedDomainSchema>;

export async function assertHostedSiteCustomDomains(): Promise<void> {
  const client = initClient(featureSwitchesContract, await getClientConfig());
  const response = await client.get({ fetchOptions: { cache: "no-store" } });
  if (response.status !== 200) {
    handleError(response, "Could not check custom domain availability");
  }
  const { effectiveSwitches } = featureSwitchesResponseSchema.parse(
    response.body,
  );
  if (effectiveSwitches[FeatureSwitchKey.HostedSiteCustomDomains] !== true) {
    throw new Error(
      "Custom domains are not enabled for this account and workspace. No domain settings were changed.",
    );
  }
}

function readSettingsResponse(
  response: { readonly status: number; readonly body: unknown },
  siteId: string,
  message: string,
): HostedSiteDomainSettings {
  if (response.status !== 200) {
    handleError(response, message);
  }
  const settings = hostedDomainSettingsSchema.parse(response.body);
  if (settings.siteId !== siteId) {
    throw new Error("The API returned domain settings for a different website");
  }
  return settings;
}

export async function getHostedSiteDomains(publicSlug: string) {
  const client = initClient(hostContract, await getClientConfig());
  const response = await client.resolveAlias({
    params: { publicSlug },
    query: { publicBrand: "okou" },
    fetchOptions: { cache: "no-store" },
  });
  if (response.status !== 200) {
    handleError(response, "Published website not found");
  }
  const { pointer } = hostContract.resolveAlias.responses[200].parse(
    response.body,
  );
  if (!pointer) {
    throw new ApiRequestError("Published website not found", "NOT_FOUND", 404);
  }
  return readSettingsResponse(
    await client.siteDomains({
      params: { siteId: pointer.siteId },
      fetchOptions: { cache: "no-store" },
    }),
    pointer.siteId,
    "Could not read website domains",
  );
}

export async function addHostedSiteDomain(
  current: HostedSiteDomainSettings,
  hostname: string,
) {
  const client = initClient(hostContract, await getClientConfig());
  return readSettingsResponse(
    await client.addSiteDomain({
      params: { siteId: current.siteId },
      body: { hostname },
    }),
    current.siteId,
    "Could not add the domain",
  );
}

export async function verifyHostedSiteDomain(
  current: HostedSiteDomainSettings,
  domain: HostedSiteDomain,
) {
  const client = initClient(hostContract, await getClientConfig());
  return readSettingsResponse(
    await client.verifySiteDomain({
      params: { siteId: current.siteId, domainId: domain.id },
      body: { expectedRevision: domain.revision },
    }),
    current.siteId,
    "Could not verify the domain",
  );
}

export async function selectHostedSiteDomain(
  current: HostedSiteDomainSettings,
  publicSlug: string,
  domain: HostedSiteDomain | null,
) {
  const client = initClient(hostContract, await getClientConfig());
  return readSettingsResponse(
    await client.selectSiteDomain({
      params: { siteId: current.siteId },
      body: {
        domainId: domain?.id ?? null,
        expectedRevision: current.revision,
        expectedPublicSlug: publicSlug,
      },
    }),
    current.siteId,
    "Could not save the website address",
  );
}

export async function removeHostedSiteDomain(
  current: HostedSiteDomainSettings,
  domain: HostedSiteDomain,
) {
  const client = initClient(hostContract, await getClientConfig());
  return readSettingsResponse(
    await client.removeSiteDomain({
      params: { siteId: current.siteId, domainId: domain.id },
      body: { expectedRevision: domain.revision },
    }),
    current.siteId,
    "Could not disconnect the domain",
  );
}
