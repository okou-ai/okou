import { API_TEST_CONNECTOR_CATALOG } from "../../../../test-fixtures/connector-catalog";

export function automaticMcpCatalogFixture(
  variant:
    | "none"
    | "oauth"
    | "static-headers"
    | "declared-scopes"
    | "provider-prompt"
    | "explicit-prompt" = "oauth",
) {
  const slug = `automatic-mcp-${variant}`;
  const connector = API_TEST_CONNECTOR_CATALOG.connectors.find((entry) => {
    return entry.slug === slug;
  });
  if (!connector?.mcp || connector.firewall.kind !== "generated") {
    throw new Error("Expected the shared automatic MCP connector");
  }
  const api = connector.firewall.config.apis[0];
  if (!api) {
    throw new Error("Expected the shared automatic MCP firewall");
  }
  const firewallAuthHeaders = { ...api.auth.headers };
  return {
    slug,
    methodId: "smart-connect",
    endpoint: connector.mcp.endpoint,
    firewallAuthHeaders,
    target: { kind: "builtin" as const, connectorSlug: slug },
  };
}
