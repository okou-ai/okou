import { array, literal, object, tuple, url, type infer as zInfer } from "zod";

import { initContract } from "./base";

const c = initContract();

export const okouMcpOAuthClientMetadataSchema = object({
  client_id: url(),
  client_name: literal("Okou"),
  client_uri: url(),
  redirect_uris: array(url()).min(1),
  grant_types: tuple([literal("authorization_code"), literal("refresh_token")]),
  response_types: tuple([literal("code")]),
  application_type: literal("web"),
  token_endpoint_auth_method: literal("none"),
});
export type OkouMcpOAuthClientMetadata = zInfer<
  typeof okouMcpOAuthClientMetadataSchema
>;

export const mcpOAuthContract = c.router({
  okouClientMetadata: {
    method: "GET",
    path: "/api/oauth/mcp/client-metadata/okou.json",
    responses: {
      200: okouMcpOAuthClientMetadataSchema,
    },
    summary: "Get the Okou MCP OAuth client metadata document",
  },
});
export type McpOAuthContract = typeof mcpOAuthContract;
