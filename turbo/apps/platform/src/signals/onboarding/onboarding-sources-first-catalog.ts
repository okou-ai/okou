import { command, computed } from "ccstate";
import { onboardingSourcesContract } from "@okouai/api-contracts/contracts/onboarding";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { PlatformConnectorCatalogConnectItem } from "../connector-domain.ts";
import { builtinConnectorsReloadVersion$ } from "../external/connectors.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { waitForOperation } from "../utils.ts";

/**
 * The onboarding sources with what their cards draw and what connecting one
 * from a single click needs. Onboarding reads this rather than the catalog.
 */
export const onboardingSourceConnectors$ = computed(
  async (get): Promise<readonly PlatformConnectorCatalogConnectItem[]> => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const client = get(apiClient$)(onboardingSourcesContract);
    const result = await accept(client.list(), [200]);
    return result.body.connectors;
  },
);

/** Wait for the sources already requested by the first onboarding step. */
export const waitForSourcesFirstCatalog$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    await waitForOperation(get(onboardingSourceConnectors$), signal);
    signal.throwIfAborted();
  },
);
