import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  connectorAccountSetupSchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import { connectorResponseConnectionStatusSchema } from "./connector-schemas";

const c = initContract();

export const mcpConnectorSchema = z.object({
  // #41309 requires old-API retirement and client/Runner gates before requiring these facts.
  ...connectorAccountSetupSchema.partial().shape,
  target: connectorAccountTargetSchema,
  connectionId: z.uuid(),
  slug: z.string().min(1),
  displayName: z.string().min(1),
  transport: z.literal("streamable-http"),
  endpoint: z.string().min(1),
  // Reader-first rollout; #41699 requires this after the prepared API/CLI/Runner release.
  runtimeAvailable: z.boolean().optional(),
  connected: z.boolean(),
  connectionStatus: connectorResponseConnectionStatusSchema.optional(),
});
export type McpConnector = z.infer<typeof mcpConnectorSchema>;

export const mcpConnectorListResponseSchema = z.object({
  connectors: z.array(mcpConnectorSchema),
});

export const mcpOAuthScopeTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u);

export const mcpOAuthScopeListSchema = z
  .array(mcpOAuthScopeTokenSchema)
  .min(1)
  .max(100)
  .refine((scopes) => {
    return new Set(scopes).size === scopes.length;
  }, "MCP OAuth scopes must be unique");

export const mcpConnectorOAuthReauthorizationRequestSchema = z.object({
  target: connectorAccountTargetSchema,
  scopes: mcpOAuthScopeListSchema,
});
export type McpConnectorOAuthReauthorizationRequest = z.infer<
  typeof mcpConnectorOAuthReauthorizationRequestSchema
>;

export const mcpConnectorOAuthReauthorizationResponseSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("oauth"),
      authorizationUrl: z.string().url(),
      expiresAt: z.iso.datetime(),
    }),
    z.object({
      kind: z.literal("reconnect"),
      connectionId: z.uuid(),
      authorizationUrl: z.string().url(),
    }),
  ]);
export type McpConnectorOAuthReauthorizationResponse = z.infer<
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
