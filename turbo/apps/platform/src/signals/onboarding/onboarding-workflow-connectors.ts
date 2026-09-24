import { computed } from "ccstate";
import {
  onboardingWorkflowConnectorsContract,
  type OnboardingWorkflowConnector,
} from "@okouai/api-contracts/contracts/onboarding";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

/**
 * Label and icon for every connector an onboarding workflow names. The
 * workflow pages read this rather than the whole connector catalog.
 */
export const onboardingWorkflowConnectorsBySlug$ = computed(
  async (
    get,
  ): Promise<ReadonlyMap<ConnectorSlug, OnboardingWorkflowConnector>> => {
    get(featureSwitch$);
    const client = get(apiClient$)(onboardingWorkflowConnectorsContract);
    const result = await accept(client.list(), [200]);
    return new Map(
      result.body.connectors.map((connector) => {
        return [connector.slug, connector];
      }),
    );
  },
);
