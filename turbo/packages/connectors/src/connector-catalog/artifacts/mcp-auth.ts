import type { FirewallApi } from "../../firewall-contracts";

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
    !Object.hasOwn(headers, "Authorization") ||
    headers.Authorization !==
      AUTOMATIC_MCP_RUNTIME_FIREWALL_AUTH.headers.Authorization ||
    Object.keys(headers).length > 8
  ) {
    return null;
  }

  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (names.has(normalized)) {
      return null;
    }
    names.add(normalized);
    if (name === "Authorization") {
      continue;
    }
    // Only reviewed public configuration headers belong here. A literal
    // value or an X- prefix does not establish non-credential semantics.
    // Public selector: https://docs.datadoghq.com/mcp_server/setup/#toolsets
    if (
      normalized !== "x-datadog-mcp-toolsets" ||
      value.length === 0 ||
      value.length > 1_024 ||
      /[^a-z0-9,-]/u.test(value)
    ) {
      return null;
    }
    const toolsets = value.split(",");
    if (
      toolsets.length > 32 ||
      toolsets.some((toolset) => {
        return toolset.length > 64 || !/^[a-z]/u.test(toolset);
      })
    ) {
      return null;
    }
  }
  return "oauth";
}
