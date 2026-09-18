import { computed } from "ccstate";
import {
  CONNECTOR_CONTRACT_BUILTIN_MCP_V1,
  CONNECTOR_CONTRACT_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogItem } from "@okouai/api-contracts/contracts/connector-catalog";

import { request$ } from "../context/hono";
import { db$ } from "../external/db";
import { loadAcceptedConnectorCatalogSnapshot } from "./connector-catalog-external-reader.service";

/** Negotiation changes response compatibility, never account or Run authority. */
export const connectorClientSupportsBuiltinMcp$ = computed((get) => {
  return (
    get(request$).header(CONNECTOR_CONTRACT_HEADER) ===
    CONNECTOR_CONTRACT_BUILTIN_MCP_V1
  );
});

export const connectorClientAllowsMetadata$ = computed((get) => {
  const supported = get(connectorClientSupportsBuiltinMcp$);
  return (connector: Pick<PublicConnectorCatalogItem, "mcp">): boolean => {
    return supported || connector.mcp === undefined;
  };
});

export function connectorClientUpgradeRequired(): Response {
  return Response.json(
    {
      error: {
        code: "CONNECTOR_CLIENT_UPGRADE_REQUIRED",
        message:
          "Update Okou and reload the app, or update the Okou CLI, to use this connector.",
      },
    },
    { status: 426, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Classify protocol only from explicit metadata in the accepted catalog.
 * Remove the legacy projection in #34913 after capable App rollout, the later
 * client floor, and old API serving/rollback drain; keep direct-action negotiation.
 */
export const connectorClientProjection$ = computed(async (get) => {
  const supported = get(connectorClientSupportsBuiltinMcp$);
  const hiddenSlugs = new Set<string>();
  if (!supported) {
    const catalog = await loadAcceptedConnectorCatalogSnapshot(get(db$));
    for (const connector of catalog.artifact.connectors) {
      if (connector.mcp !== undefined) {
        hiddenSlugs.add(connector.slug);
      }
    }
  }
  const allowsSlug = (slug: string): boolean => {
    return !hiddenSlugs.has(slug);
  };
  const allowsTarget = (target: ConnectorAccountTarget): boolean => {
    return target.kind !== "builtin" || allowsSlug(target.connectorSlug);
  };
  return { allowsSlug, allowsTarget, hiddenSlugs };
});

export function connectorClientSelectionGuard(
  selections: readonly { readonly target: ConnectorAccountTarget }[],
) {
  return computed(async (get): Promise<Response | null> => {
    if (
      !selections.some((selection) => {
        return selection.target.kind === "builtin";
      })
    ) {
      return null;
    }
    const projection = await get(connectorClientProjection$);
    return selections.some((selection) => {
      return !projection.allowsTarget(selection.target);
    })
      ? connectorClientUpgradeRequired()
      : null;
  });
}
