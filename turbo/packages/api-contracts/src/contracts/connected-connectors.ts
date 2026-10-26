import {
  array,
  boolean,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { publicConnectorCatalogIconSchema } from "./connector-catalog";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const builtinConnectorBriefSchema = object({
  slug: connectorSlugSchema,
  label: string(),
  icon: publicConnectorCatalogIconSchema,
  hasPermissions: boolean(),
});

export const customConnectorBriefSchema = object({
  id: uuid(),
  slug: string(),
  displayName: string(),
  permissionBundleRef: string().nullable(),
  integrationManaged: boolean(),
});

export type BuiltinConnectorBrief = zInfer<typeof builtinConnectorBriefSchema>;
export type CustomConnectorBrief = zInfer<typeof customConnectorBriefSchema>;

// Saved accounts provide directory visibility, not execution authorization.
export const connectedConnectorsSchema = object({
  builtinConnectors: array(builtinConnectorBriefSchema),
  customConnectors: array(customConnectorBriefSchema),
});

export type ConnectedConnectors = zInfer<typeof connectedConnectorsSchema>;

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
