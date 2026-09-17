import { env } from "./env";

export const MCP_READ_SCOPE = "okou:chat:read";
export const MCP_REQUIRED_SCOPES = ["user:org:read", MCP_READ_SCOPE] as const;
export const MCP_SCOPES = [
  ...MCP_REQUIRED_SCOPES,
  "okou:chat:send",
  "okou:chat:manage",
  "okou:run:cancel",
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

export function allowedMcpOrigin(origin: string): boolean {
  const origins = env("MCP_ALLOWED_ORIGINS")?.split(",") ?? [];
  return origins.some((entry) => {
    const allowed = entry.trim();
    if (!allowed) {
      return false;
    }
    const url = configuredUrl(allowed);
    if (allowed !== url.origin) {
      throw new Error("MCP_ALLOWED_ORIGINS must contain exact HTTPS origins");
    }
    return origin === allowed;
  });
}
