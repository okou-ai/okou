import { AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE } from "@okouai/connectors/connector-catalog/artifacts/mcp-auth";

import { API_TEST_CONNECTOR_CATALOG } from "../../../../test-fixtures/connector-catalog";

export function automaticMcpCatalogFixture(
  firewallAuth: "none" | "oauth" = "oauth",
) {
  const slug = `automatic-mcp-${firewallAuth}`;
  const connector = API_TEST_CONNECTOR_CATALOG.connectors.find((entry) => {
    return entry.slug === slug;
  });
  if (!connector?.mcp) {
    throw new Error("Expected the shared automatic MCP connector");
  }
  const firewallAuthHeaders: Record<string, string> =
    firewallAuth === "none"
      ? {}
      : { Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE };
  return {
    slug,
    methodId: "smart-connect",
    endpoint: connector.mcp.endpoint,
    firewallAuthHeaders,
    target: { kind: "builtin" as const, connectorSlug: slug },
  };
}
