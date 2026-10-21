import { command, computed } from "ccstate";
import { onboardingSourcesReaderContract as onboardingSourcesContract } from "@okouai/api-contracts/contracts/connector-catalog-readers";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  builtinConnectorsReloadVersion$,
  withBuiltinConnectorDefaults,
} from "../external/connectors.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

/**
 * The onboarding sources with what their cards draw and what connecting one
 * from a single click needs. Onboarding reads this rather than the catalog.
 */
export const onboardingSourceConnectors$ = withBuiltinConnectorDefaults(
  computed(async (get) => {
    get(builtinConnectorsReloadVersion$);
    get(featureSwitch$);
    const createClient = get(apiClient$);
    const client = createClient(onboardingSourcesContract);
    const result = await accept(client.list(), [200]);
    return result.body.connectors;
  }),
);

/** Wait for the sources already requested by the first onboarding step. */
export const waitForSourcesFirstCatalog$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    await get(onboardingSourceConnectors$);
    signal.throwIfAborted();
  },
);
