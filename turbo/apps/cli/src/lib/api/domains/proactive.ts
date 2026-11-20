import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
import { getClientConfig, handleError } from "../core/client-factory";

const contracts = {
  "morning-brief": morningBriefPreferenceContract,
  suggestions: {
    get: proactiveSuggestionsContract.get,
    update: proactiveSuggestionsContract.updateWithFeed,
  },
} as const;

const sources = {
  "whats-new": "whatsNew",
  offers: "offers",
  "system-updates": "systemUpdates",
} as const;

export type ProactiveFeature = keyof typeof contracts | keyof typeof sources;
export type ProactiveSetting =
  ProactivePreference | { readonly enabled: boolean };

function isWorkflowFeature(
  feature: ProactiveFeature,
): feature is keyof typeof contracts {
  return feature in contracts;
}

export async function getProactivePreference(feature: ProactiveFeature) {
  if (!isWorkflowFeature(feature)) {
    const client = initClient(feedContract, {
      ...(await getClientConfig()),
      validateResponse: true,
    });
    const result = await client.sources({ headers: {} });
    if (result.status !== 200) {
      handleError(result, `Failed to read ${feature} preference`);
    }
    return { enabled: result.body[sources[feature]] };
  }
  const client = initClient(contracts[feature], {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.get({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to read ${feature} preference`);
}

export async function updateProactivePreference(
  feature: ProactiveFeature,
  enabled: boolean,
) {
  if (!isWorkflowFeature(feature)) {
    const client = initClient(feedContract, {
      ...(await getClientConfig()),
      validateResponse: true,
    });
    const result = await client.updateSources({
      headers: {},
      body: { [sources[feature]]: enabled },
    });
    if (result.status !== 200) {
      handleError(result, `Failed to update ${feature} preference`);
    }
    return { enabled: result.body[sources[feature]] };
  }
  const client = initClient(contracts[feature], {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.update({ headers: {}, body: { enabled } });
  if (result.status === 200) return result.body;
  handleError(result, `Failed to update ${feature} preference`);
}
