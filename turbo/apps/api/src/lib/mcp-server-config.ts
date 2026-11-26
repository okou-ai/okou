import { env } from "./env";

export const MCP_READ_SCOPE = "okou:chat:read";
export const MCP_REQUIRED_SCOPES = ["user:org:read", MCP_READ_SCOPE] as const;
// Request the complete initial grant even when clients cannot add scopes later.
export const MCP_DEFAULT_SCOPES = [
  "openid",
  "email",
  "profile",
  ...MCP_REQUIRED_SCOPES,
  "okou:project:read",
  "okou:chat:send",
  "okou:chat:manage",
  "okou:run:cancel",
  "offline_access",
] as const;

// Optional native-client grants are advertised, not added to MCP's default consent.
export const MCP_SUPPORTED_SCOPES = [
  ...MCP_DEFAULT_SCOPES,
  "okou:voice:transcribe",
] as const;

function configuredUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MCP identities must be HTTPS URLs without credentials, query or fragment",
    );
  }
  return url;
}

export function mcpServerConfig() {
  const resource = env("MCP_RESOURCE_URL");
  const issuer = env("MCP_OAUTH_ISSUER");
  if (!resource || !issuer) {
    return undefined;
  }
  const resourceUrl = configuredUrl(resource);
  configuredUrl(issuer);
  if (resourceUrl.pathname !== "/mcp") {
    throw new Error("MCP_RESOURCE_URL must identify the /mcp endpoint");
  }
  return {
    resource,
    issuer,
    metadataUrl: new URL(
      "/.well-known/oauth-protected-resource/mcp",
      resourceUrl,
    ).href,
  };
}
