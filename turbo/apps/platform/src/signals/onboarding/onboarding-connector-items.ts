import { computed } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { onboardingWorkflowConnectorSlugs } from "../../views/onboarding/onboarding-data.ts";
import { connectorCatalogItemsForSlugs } from "../external/connectors.ts";
import { searchParams$ } from "../route.ts";
import { onboardingDraft$ } from "./onboarding-state.ts";

/** The connectors of the workflow the onboarding run page sets up. */
export const onboardingWorkflowConnectorItems$ = connectorCatalogItemsForSlugs(
  computed((get) => {
    return onboardingWorkflowConnectorSlugs(get(onboardingDraft$).workflowId);
  }),
);

/** The connectors a template link names in its `connector` parameter. */
export const onboardingMakeConnectorItems$ = connectorCatalogItemsForSlugs(
  computed((get): readonly ConnectorSlug[] => {
    return (get(searchParams$).get("connector") ?? "")
      .split(",")
      .flatMap((value) => {
        const parsed = connectorSlugSchema.safeParse(value.trim());
        return parsed.success ? [parsed.data] : [];
      });
  }),
);
