import {
  array,
  boolean,
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  url,
  uuid,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  connectorAccountFieldMetadataSchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import {
  connectorReconnectReasonSchema,
  connectorResponseConnectionStatusSchema,
} from "./connector-schemas";

const c = initContract();

export const mcpConnectorSchema = object({
  ...connectorAccountFieldMetadataSchema.shape,
  target: connectorAccountTargetSchema,
  connectionId: uuid(),
  slug: string().min(1),
  displayName: string().min(1),
  transport: literal("streamable-http"),
  endpoint: string().min(1),
  runtimeAvailable: boolean(),
  connectionStatus: connectorResponseConnectionStatusSchema,
  reconnectReason: connectorReconnectReasonSchema.nullable(),
});
export type McpConnector = zInfer<typeof mcpConnectorSchema>;

export const mcpConnectorListResponseSchema = object({
  connectors: array(mcpConnectorSchema),
});

export const mcpOAuthScopeTokenSchema = string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u);

export const mcpOAuthScopeListSchema = array(mcpOAuthScopeTokenSchema)
  .min(1)
  .max(100)
  .refine((scopes) => {
    return new Set(scopes).size === scopes.length;
  }, "MCP OAuth scopes must be unique");

export const mcpConnectorOAuthReauthorizationRequestSchema = object({
  target: connectorAccountTargetSchema,
  scopes: mcpOAuthScopeListSchema,
});
export type McpConnectorOAuthReauthorizationRequest = zInfer<
  typeof mcpConnectorOAuthReauthorizationRequestSchema
>;

export const mcpConnectorOAuthReauthorizationResponseSchema =
  discriminatedUnion("kind", [
    object({
      kind: literal("oauth"),
      authorizationUrl: url(),
      expiresAt: iso.datetime(),
    }),
    object({
      kind: literal("reconnect"),
      connectionId: uuid(),
      authorizationUrl: url(),
    }),
  ]);
export type McpConnectorOAuthReauthorizationResponse = zInfer<
  typeof mcpConnectorOAuthReauthorizationResponseSchema
>;

export const mcpConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/mcp-connectors",
    headers: authHeadersSchema,
    responses: {
      200: mcpConnectorListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List MCP connectors authorized for the current Agent Run",
  },
  reauthorizeOAuth: {
    method: "POST",
    path: "/api/mcp-connectors/oauth2/reauthorize",
    headers: authHeadersSchema,
    body: mcpConnectorOAuthReauthorizationRequestSchema,
    responses: {
      200: mcpConnectorOAuthReauthorizationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Reauthorize MCP OAuth scopes for the current Agent Run",
  },
});

export type McpConnectorsContract = typeof mcpConnectorsContract;
