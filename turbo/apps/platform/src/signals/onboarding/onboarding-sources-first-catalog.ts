import { command, computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS } from "@okouai/api-contracts/contracts/onboarding";
import { connectorCatalogItemsForSlugs } from "../external/connectors.ts";
import { waitForOperation } from "../utils.ts";

const sourcesFirstFeaturedSlugs$ = computed((): readonly ConnectorSlug[] => {
  return ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS;
});

/**
 * Catalog entries, with the current user's connection state, for the sources
 * the flow offers. Every field's grid, the ready step's source match, and a
 * connected source kept on screen come from this fixed set.
 */
export const sourcesFirstCatalogItems$ = connectorCatalogItemsForSlugs(
  sourcesFirstFeaturedSlugs$,
);

/** Wait for the sources requested by the first onboarding step. */
export const waitForSourcesFirstCatalog$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    await waitForOperation(get(sourcesFirstCatalogItems$), signal);
    signal.throwIfAborted();
  },
);
