import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import {
  connectorAccountConnectionSchema,
  connectorAccountSummarySchema,
} from "./connector-accounts";
import { publicConnectorCatalogIconSchema } from "./connector-catalog";
import { connectorSlugSchema } from "./connector-identity";
import { computerUseHostSchema } from "./computer-use";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const composerBuiltinConnectorSchema = z.object({
  slug: connectorSlugSchema,
  label: z.string(),
  icon: publicConnectorCatalogIconSchema,
  hasPermissions: z.boolean(),
});

export const composerCustomConnectorSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  permissionBundleRef: z.string().nullable(),
  integrationManaged: z.boolean(),
});

export const composerComputerUseHostSchema = computerUseHostSchema
  .pick({
    id: true,
    hostName: true,
    displayName: true,
    lastSeenAt: true,
    status: true,
  })
  .extend({ hostName: z.string() });

export const composerDefaultAccountSchema =
  connectorAccountConnectionSchema.pick({
    id: true,
    authMethod: true,
    displayName: true,
    externalId: true,
    externalUsername: true,
    externalEmail: true,
    connectionStatus: true,
  });

export const composerAccountSummarySchema = connectorAccountSummarySchema
  .omit({ defaultConnection: true })
  .extend({ defaultConnection: composerDefaultAccountSchema.nullable() });

export type ComposerDefaultAccount = z.infer<
  typeof composerDefaultAccountSchema
>;
export type ComposerAccountSummary = z.infer<
  typeof composerAccountSummarySchema
>;

export const composerConnectorOverviewSchema = z.object({
  builtinConnectors: z.array(composerBuiltinConnectorSchema),
  customConnectors: z.array(composerCustomConnectorSchema),
  accountSummaries: z.array(composerAccountSummarySchema),
  computerUseHosts: z.array(composerComputerUseHostSchema),
  cloudBrowserEnabledByDefault: z.boolean(),
});

export type ComposerConnectorOverview = z.infer<
  typeof composerConnectorOverviewSchema
>;
export type ComposerBuiltinConnector = z.infer<
  typeof composerBuiltinConnectorSchema
>;
export type ComposerCustomConnector = z.infer<
  typeof composerCustomConnectorSchema
>;

export const composerAgentConnectorsSchema = z.object({
  enabledConnectorSlugs: z.array(connectorSlugSchema),
  customConnectorIds: z.array(z.uuid()),
});

export type ComposerAgentConnectors = z.infer<
  typeof composerAgentConnectorsSchema
>;

export const composerConnectorsContract = c.router({
  overview: {
    method: "GET",
    path: "/api/composer/connectors",
    headers: authHeadersSchema,
    responses: {
      200: composerConnectorOverviewSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get connected connectors and computer access for the composer",
  },
  agent: {
    method: "GET",
    path: "/api/agents/:id/composer-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: composerAgentConnectorsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector authorization for one composer Agent",
  },
});
