import { command, computed, state } from "ccstate";
import { IDEATION_CONNECTOR_SLUGS } from "../../views/okou-page/ideation-data.ts";
import { connectorCatalogBriefs } from "../external/connectors.ts";

/**
 * Label and icon for every connector an ideation use case names, in one
 * request. A slug the current user cannot see is absent, which hides the use
 * cases that need it.
 */
export const ideationConnectorBriefs$ = connectorCatalogBriefs(
  IDEATION_CONNECTOR_SLUGS,
);

// ---------------------------------------------------------------------------
// Active tab state
// ---------------------------------------------------------------------------
const internalActiveTab$ = state("all");
export const ideationActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});
export const setIdeationActiveTab$ = command(({ set }, tab: string) => {
  set(internalActiveTab$, tab);
});

// ---------------------------------------------------------------------------
// Search query state
// ---------------------------------------------------------------------------
const internalSearchQuery$ = state("");
export const ideationSearchQuery$ = computed((get) => {
  return get(internalSearchQuery$);
});
export const setIdeationSearchQuery$ = command(({ set }, query: string) => {
  set(internalSearchQuery$, query);
});
