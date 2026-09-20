import type { OAuthClientMetadata } from "@modelcontextprotocol/client";
import type { OkouMcpOAuthClientMetadata } from "@okouai/api-contracts/contracts/mcp-oauth";

import { env } from "../../lib/env";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";

const OKOU_MCP_OAUTH_CLIENT_METADATA_PATH =
  "/api/oauth/mcp/client-metadata/okou.json";
const CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH = "/connectors/custom/callback";

export function builtinConnectorAutomaticOAuthRedirectUri(
  request: Request,
): string {
  return new URL(
    "/api/connectors/automatic/callback",
    getOAuthApiOrigin(request),
  ).toString();
}

export function okouMcpOAuthClientMetadata(
  request: Request,
): OkouMcpOAuthClientMetadata & OAuthClientMetadata {
  const apiOrigin = getOAuthApiOrigin(request);
  const appOrigin = env("APP_URL");
  const metadata: OkouMcpOAuthClientMetadata & OAuthClientMetadata = {
    client_id: new URL(
      OKOU_MCP_OAUTH_CLIENT_METADATA_PATH,
      apiOrigin,
    ).toString(),
    client_name: "Okou",
    client_uri: new URL("/", appOrigin).toString(),
    redirect_uris: [
      new URL(CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH, appOrigin).toString(),
      builtinConnectorAutomaticOAuthRedirectUri(request),
    ],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "none",
  };
  return metadata;
}

export function okouMcpOAuthDynamicClientMetadata(
  request: Request,
  target: "custom" | "builtin" = "custom",
): OAuthClientMetadata {
  const metadata = okouMcpOAuthClientMetadata(request);
  return {
    client_name: metadata.client_name,
    client_uri: metadata.client_uri,
    redirect_uris: [
      target === "builtin"
        ? builtinConnectorAutomaticOAuthRedirectUri(request)
        : new URL(
            CUSTOM_CONNECTOR_OAUTH_CALLBACK_PATH,
            env("APP_URL"),
          ).toString(),
    ],
    grant_types: metadata.grant_types,
    response_types: metadata.response_types,
    application_type: metadata.application_type,
  };
}

export function configuredOkouMcpOAuthClientMetadata(): OkouMcpOAuthClientMetadata &
  OAuthClientMetadata {
  return okouMcpOAuthClientMetadata(new Request(env("APP_URL")));
}
