import type { FirewallApi } from "../../firewall-contracts.js";

export const AUTOMATIC_MCP_RUNTIME_ACCESS_TOKEN_SECRET_NAME =
  "MCP_ACCESS_TOKEN";

export const AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE = `Bearer \${{ secrets.${AUTOMATIC_MCP_RUNTIME_ACCESS_TOKEN_SECRET_NAME} }}`;

export const AUTOMATIC_MCP_RUNTIME_FIREWALL_AUTH = Object.freeze({
  headers: Object.freeze({
    Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
  }),
});

/** Shared by catalog acceptance and the private credential boundary. */
export function automaticMcpRuntimeFirewallAuthKind(
  auth: FirewallApi["auth"] | undefined,
): "none" | "oauth" | null {
  if (auth === undefined) {
    return null;
  }
  const fields = Object.keys(auth);
  if (fields.length === 0) {
    return "none";
  }
  const headers = auth.headers;
  if (
    fields.length !== 1 ||
    headers === undefined ||
    headers.Authorization !==
      AUTOMATIC_MCP_RUNTIME_FIREWALL_AUTH.headers.Authorization
  ) {
    return null;
  }
  return "oauth";
}
