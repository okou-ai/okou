import { marketingHandoff$ } from "../prompt-page/marketing-handoff.ts";
import { computed } from "ccstate";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorCatalogItemsForSlugs,
  withBuiltinConnectorDefaults,
} from "../external/connectors.ts";
import { searchParams$ } from "../route.ts";

const RECOMMENDED_OAUTH_CONNECTOR_SLUGS = [
  "gmail",
  "google-drive",
  "google-calendar",
  "google-docs",
  "google-sheets",
  "google-ads",
  "notion",
  "github",
] as const satisfies readonly ConnectorSlug[];

const requestedConnectorSlugs$ = computed((get) => {
  const requested = get(searchParams$).has("handoff")
    ? get(marketingHandoff$)?.manifest.options.connector
    : get(searchParams$).get("connector");
  return (requested ?? "").split(",").flatMap((value) => {
    const parsed = connectorSlugSchema.safeParse(value.trim());
    return parsed.success ? [parsed.data] : [];
  });
});

/** Every prompt handoff offers connections, with the link's tools first. */
export const onboardingMakeConnectorSlugs$ = computed(
  (get): readonly ConnectorSlug[] => {
    return [
      ...new Set([
        ...get(requestedConnectorSlugs$),
        ...RECOMMENDED_OAUTH_CONNECTOR_SLUGS,
      ]),
    ];
  },
);

const promptConnectorCatalogItems$ = connectorCatalogItemsForSlugs(
  onboardingMakeConnectorSlugs$,
);

export const onboardingMakeConnectorItems$ = withBuiltinConnectorDefaults(
  computed(async (get) => {
    const requestedSlugs = get(requestedConnectorSlugs$);
    const items = await get(promptConnectorCatalogItems$);
    // The live catalog owns OAuth availability. Explicitly requested tools
    // retain their own connection methods, including manual credentials.
    return items.filter((item) => {
      return (
        requestedSlugs.includes(item.slug) ||
        item.authMethods.some((method) => {
          return (
            method.grantKind === "auth-code" ||
            method.grantKind === "device-auth"
          );
        })
      );
    });
  }),
);
