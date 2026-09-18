import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const okouMcpOAuthClientMetadataSchema = z.object({
  client_id: z.url(),
  client_name: z.literal("Okou"),
  client_uri: z.url(),
  redirect_uris: z.array(z.url()).min(1),
  grant_types: z.tuple([
    z.literal("authorization_code"),
    z.literal("refresh_token"),
  ]),
  response_types: z.tuple([z.literal("code")]),
  application_type: z.literal("web"),
  token_endpoint_auth_method: z.literal("none"),
});
export type OkouMcpOAuthClientMetadata = z.infer<
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
