import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { publicConnectorCatalogIconSchema } from "./connector-catalog";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const builtinConnectorBriefSchema = z.object({
  slug: connectorSlugSchema,
  label: z.string(),
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

export type BuiltinConnectorBrief = z.infer<typeof builtinConnectorBriefSchema>;
export type CustomConnectorBrief = z.infer<typeof customConnectorBriefSchema>;

// Saved accounts provide directory visibility, not execution authorization.
export const connectedConnectorsSchema = z.object({
  builtinConnectors: z.array(builtinConnectorBriefSchema),
  customConnectors: z.array(customConnectorBriefSchema),
});

export type ConnectedConnectors = z.infer<typeof connectedConnectorsSchema>;

export const connectedConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/connectors/connected",
    headers: authHeadersSchema,
    responses: {
      200: connectedConnectorsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List connector briefs for the user's saved accounts",
  },
});
