import { command, computed } from "ccstate";
import { onboardingSourcesContract } from "@okouai/api-contracts/client/onboarding";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  builtinConnectorsReloadVersion$,
  withBuiltinConnectorDefaults,
} from "../external/connectors.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { navigateTo$, searchParams$ } from "../route.ts";
import { rootSignal$ } from "../root-signal.ts";
import {
  nextSourcesFirstStep,
  SOURCES_FIRST_STEP_ROUTES,
  sourcesFirstDraft$,
  sourcesFirstFlow$,
} from "./onboarding-sources-first-state.ts";

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

/** Continue the industry step after its existing source request is ready. */
export const continueSourcesFirstIndustry$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const next = nextSourcesFirstStep(
      "industry",
      get(sourcesFirstFlow$),
      get(sourcesFirstDraft$).provider,
    );
    const searchParams = new URLSearchParams(get(searchParams$));
    await get(onboardingSourceConnectors$);
    signal.throwIfAborted();
    if (next) {
      // Navigation replaces this page and belongs to the app lifetime.
      await set(
        navigateTo$,
        SOURCES_FIRST_STEP_ROUTES[next],
        { searchParams },
        get(rootSignal$),
      );
    }
  },
);
