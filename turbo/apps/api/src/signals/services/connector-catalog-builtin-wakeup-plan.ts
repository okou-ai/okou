import { isDeepStrictEqual } from "node:util";
import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectors } from "@okouai/db/schema/connector";
import { and, inArray, isNull, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";

type BuiltinRuntimeConnector = Pick<
  ConnectorCatalogArtifactConnector,
  "slug" | "mcp" | "authMethods" | "firewall"
>;

function builtinRuntimeConfig(connector: BuiltinRuntimeConnector | undefined) {
  return connector
    ? {
        mcp: connector.mcp,
        authMethods: connector.authMethods,
        firewall: connector.firewall,
      }
    : undefined;
}

export function builtinCatalogWakeupReadPlan(args: {
  readonly previousArtifact:
    { readonly connectors: readonly BuiltinRuntimeConnector[] } | undefined;
  readonly currentArtifact: {
    readonly connectors: readonly BuiltinRuntimeConnector[];
  };
}) {
  const previous = new Map(
    args.previousArtifact?.connectors.map((connector) => {
      return [connector.slug, connector] as const;
    }),
  );
  const current = new Map(
    args.currentArtifact.connectors.map((connector) => {
      return [connector.slug, connector] as const;
    }),
  );
  const changedSlugs = [
    ...new Set([...previous.keys(), ...current.keys()]),
  ].filter((slug) => {
    const before = previous.get(slug);
    const after = current.get(slug);
    return !isDeepStrictEqual(
      builtinRuntimeConfig(before),
      builtinRuntimeConfig(after),
    );
  });
  if (changedSlugs.length === 0) {
    return { needsRead: false as const };
  }
  return {
    needsRead: true as const,
    columns: {
      orgId: connectors.orgId,
      connectorSlug: sql`${connectors.connectorSlug}`
        .mapWith(pgTextDecoder)
        .as("connector_slug"),
    },
    condition: and(
      isNull(connectors.customConnectorId),
      inArray(connectors.connectorSlug, changedSlugs),
    ),
  };
}

export function builtinCatalogWakeupAccountsByOrg(
  accounts: readonly {
    readonly orgId: string;
    readonly connectorSlug: string;
  }[],
) {
  const byOrg = new Map<string, string[]>();
  for (const account of accounts) {
    const slugs = byOrg.get(account.orgId) ?? [];
    slugs.push(account.connectorSlug);
    byOrg.set(account.orgId, slugs);
  }
  return byOrg;
}
