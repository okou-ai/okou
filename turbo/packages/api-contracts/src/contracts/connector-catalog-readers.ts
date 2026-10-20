import { z } from "zod";
import type { ConnectorAccountConnection } from "./connector-accounts";

import { initContract } from "./base";
import { connectorReaderRouteSpec } from "./connector-reader-contract";
import {
  connectorCatalogContract,
  publicConnectorCatalogConnectItemSchema,
  publicConnectorCatalogStatusItemSchema,
} from "./connector-catalog";

const c = initContract();

// Client-only views preserve serving output; #41699 removes this tolerance
// after replacement App/CLI readers are deployed and old populations excluded.
const optionalCatalogProjection = {
  connected: true,
  connection: true,
  connectionStatus: true,
  scopeMismatch: true,
  authMethodSupportsRefresh: true,
  tokenExpiresAt: true,
} as const;
const catalogStatusReaderSchema =
  publicConnectorCatalogStatusItemSchema.partial(optionalCatalogProjection);
const catalogConnectReaderSchema =
  publicConnectorCatalogConnectItemSchema.partial(optionalCatalogProjection);
const catalogStatusListReaderSchema =
  connectorCatalogContract.status.responses[200].extend({
    connectors: z.array(catalogStatusReaderSchema),
  });
export type PublicConnectorCatalogStatusReaderItem = z.infer<
  typeof catalogStatusReaderSchema
>;
export type PublicConnectorCatalogConnectReaderItem = z.infer<
  typeof catalogConnectReaderSchema
>;

function optionalAccountFact(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new Error(
    "Connector account metadata is invalid. Refresh and try again.",
  );
}

// Old APIs omit account scope and method refresh facts. Only their exact
// default ID/method may supply either fact; never use a sibling's projection.
// #41699 removes this bridge after prepared API/App/CLI uptake and API drain.
export function readBuiltinConnectorAccountFacts(
  connector: PublicConnectorCatalogConnectReaderItem,
  account: ConnectorAccountConnection,
) {
  if (
    account.target.kind !== "builtin" ||
    account.target.connectorSlug !== connector.slug
  ) {
    throw new Error("Connector account metadata identity mismatch");
  }
  const legacyMatches =
    connector.connection?.id === account.id &&
    connector.connection.authMethod === account.authMethod;
  const method = connector.authMethods.find((candidate) => {
    return candidate.id === account.authMethod;
  });
  const scopeMismatch = optionalAccountFact(account.scopeMismatch);
  const supportsRefresh = optionalAccountFact(method?.supportsRefresh);
  return {
    scopeMismatch:
      scopeMismatch ??
      (legacyMatches
        ? optionalAccountFact(connector.scopeMismatch)
        : undefined),
    supportsRefresh:
      supportsRefresh ??
      (legacyMatches
        ? optionalAccountFact(connector.authMethodSupportsRefresh)
        : undefined),
  };
}
export type PublicConnectorCatalogStatusReaderResponse = z.infer<
  typeof catalogStatusListReaderSchema
>;
const catalogDiscoveryReaderSchema =
  connectorCatalogContract.discovery.responses[200].extend({
    connectors: z.array(catalogStatusReaderSchema),
  });
export type PublicConnectorCatalogDiscoveryReaderResponse = z.infer<
  typeof catalogDiscoveryReaderSchema
>;
export const connectorCatalogReaderContract = c.router({
  ...connectorCatalogContract,
  status: {
    ...connectorReaderRouteSpec(connectorCatalogContract.status),
    responses: {
      ...connectorCatalogContract.status.responses,
      200: catalogStatusListReaderSchema,
    },
  },
  discovery: {
    ...connectorReaderRouteSpec(connectorCatalogContract.discovery),
    responses: {
      ...connectorCatalogContract.discovery.responses,
      200: catalogDiscoveryReaderSchema,
    },
  },
  oneClick: {
    ...connectorReaderRouteSpec(connectorCatalogContract.oneClick),
    responses: {
      ...connectorCatalogContract.oneClick.responses,
      200: connectorCatalogContract.oneClick.responses[200].extend({
        connectors: z.array(catalogConnectReaderSchema),
      }),
    },
  },
  get: {
    ...connectorReaderRouteSpec(connectorCatalogContract.get),
    responses: {
      ...connectorCatalogContract.get.responses,
      200: connectorCatalogContract.get.responses[200].extend({
        connector: catalogStatusReaderSchema,
      }),
    },
  },
});
