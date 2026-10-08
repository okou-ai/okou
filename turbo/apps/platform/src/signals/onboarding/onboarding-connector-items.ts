import { computed } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { connectorCatalogItemsForSlugs } from "../external/connectors.ts";
import { searchParams$ } from "../route.ts";

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
