import { z } from "zod";

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
