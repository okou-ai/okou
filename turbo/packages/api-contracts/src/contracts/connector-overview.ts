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

export const builtinConnectorBriefSchema = z.object({
  slug: connectorSlugSchema,
  label: z.string(),
  description: z.string(),
  icon: publicConnectorCatalogIconSchema,
  hasPermissions: z.boolean(),
});

export const customConnectorBriefSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  permissionBundleRef: z.string().nullable(),
  integrationManaged: z.boolean(),
});

export const computerUseHostBriefSchema = computerUseHostSchema
  .pick({
    id: true,
    hostName: true,
    displayName: true,
    lastSeenAt: true,
    status: true,
  })
  .extend({ hostName: z.string() });

export const connectorDefaultAccountBriefSchema =
  connectorAccountConnectionSchema.pick({
    id: true,
    authMethod: true,
    displayName: true,
    externalId: true,
    externalUsername: true,
    externalEmail: true,
    connectionStatus: true,
  });

export const connectorAccountBriefSummarySchema = connectorAccountSummarySchema
  .omit({ defaultConnection: true })
  .extend({ defaultConnection: connectorDefaultAccountBriefSchema.nullable() });

export type ConnectorDefaultAccountBrief = z.infer<
  typeof connectorDefaultAccountBriefSchema
>;
export type ConnectorAccountBriefSummary = z.infer<
  typeof connectorAccountBriefSummarySchema
>;

export const connectorOverviewSchema = z.object({
  builtinConnectors: z.array(builtinConnectorBriefSchema),
  customConnectors: z.array(customConnectorBriefSchema),
  accountSummaries: z.array(connectorAccountBriefSummarySchema),
  computerUseHosts: z.array(computerUseHostBriefSchema),
  cloudBrowserEnabledByDefault: z.boolean(),
});

export type ConnectorOverview = z.infer<typeof connectorOverviewSchema>;
export type BuiltinConnectorBrief = z.infer<typeof builtinConnectorBriefSchema>;
export type CustomConnectorBrief = z.infer<typeof customConnectorBriefSchema>;

export const agentConnectorAccessSchema = z.object({
  enabledConnectorSlugs: z.array(connectorSlugSchema),
  customConnectorIds: z.array(z.uuid()),
});

export type AgentConnectorAccess = z.infer<typeof agentConnectorAccessSchema>;

export const connectorOverviewContract = c.router({
  overview: {
    method: "GET",
    path: "/api/connectors/overview",
    headers: authHeadersSchema,
    responses: {
      200: connectorOverviewSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get the user's connected connectors and computer access",
  },
  agent: {
    method: "GET",
    path: "/api/agents/:id/connector-access",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: agentConnectorAccessSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector authorization for one Agent",
  },
});
