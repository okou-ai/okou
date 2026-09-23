import { computed, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PlatformConnectorCatalogStatusItem } from "../connector-domain.ts";
import {
  connectorCatalogItemBySlug,
  connectorCatalogItemForSlug,
  relatedConnectorCatalog,
} from "../external/connectors.ts";
import { directedConnectSlug$ } from "../connectors-page/directed-connect-slug.ts";
import { directedAuthorizeSlug$ } from "../connectors-page/directed-authorize-slug.ts";
import {
  builtinConnectorScopeReviewSelection$,
  selectedBuiltinConnectorSlug$,
} from "./settings/connectors.ts";

/**
 * Catalog reads for surfaces that need one known connector, each shared by
 * every consumer so a page never pulls the full connector catalog for them.
 */

/** Shared by every artifact card that offers a Google Drive upload. */
export const googleDriveCatalogItem$ =
  connectorCatalogItemBySlug("google-drive");

export const gmailCatalogItem$ = connectorCatalogItemBySlug("gmail");

export const larkCatalogItem$ = connectorCatalogItemBySlug("lark");

/**
 * A catalog item tagged with the slug it was read for. A last-resolved read
 * keeps the previous slug's answer while the next one loads, and a `null`
 * answer carries no slug of its own, so consumers compare the tag with the
 * slug they currently expect.
 */
interface SlugCatalogItem {
  readonly connectorSlug: ConnectorSlug | null;
  readonly item: PlatformConnectorCatalogStatusItem | null;
}

function slugCatalogItem(
  connectorSlug$: Computed<ConnectorSlug | null>,
): Computed<Promise<SlugCatalogItem>> {
  const item$ = connectorCatalogItemForSlug(connectorSlug$);
  return computed(async (get) => {
    const connectorSlug = get(connectorSlug$);
    return { connectorSlug, item: await get(item$) };
  });
}

export const directedConnectCatalogItem$ =
  slugCatalogItem(directedConnectSlug$);

export const directedAuthorizeCatalogItem$ = slugCatalogItem(
  directedAuthorizeSlug$,
);

const scopeReviewConnectorSlug$ = computed((get) => {
  return get(builtinConnectorScopeReviewSelection$)?.connectorSlug ?? null;
});

export const scopeReviewCatalogItem$ = slugCatalogItem(
  scopeReviewConnectorSlug$,
);

/** Only the connector picked from the Get started quest; none while unpicked. */
export const questSelectedCatalogItem$ = slugCatalogItem(
  selectedBuiltinConnectorSlug$,
);

const questBrowseKeyword$ = computed(() => {
  return "";
});

/**
 * The keyword-free discovery browse: connected connectors plus the leading
 * connectors of each category, which is what the Get started quest offers.
 */
export const questConnectorCatalog$ =
  relatedConnectorCatalog(questBrowseKeyword$);
