import { computed } from "ccstate";
import { connectorCatalogItemsForSlugs } from "../external/connectors.ts";

export const triggerExampleConnectors$ = connectorCatalogItemsForSlugs(
  computed(() => {
    return ["gmail", "google-calendar", "slack", "x"];
  }),
);
