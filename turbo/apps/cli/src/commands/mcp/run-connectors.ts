import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";

import { listRunMcpConnectors as listRunMcpConnectorsApi } from "../../lib/api/domains/connectors";
import { findConnectorBySelector } from "../connector/connector-selector";

export function listRunMcpConnectors(): Promise<McpConnector[]> {
  return listRunMcpConnectorsApi();
}

export async function resolveRunMcpConnector(
  connectorSlug: string,
): Promise<McpConnector> {
  const connectors = await listRunMcpConnectors();
  const connector = findConnectorBySelector(
    connectors,
    connectorSlug,
    (candidate) => {
      return {
        ...(candidate.kind === "builtin"
          ? { kind: "builtin" as const }
          : { kind: "custom" as const, id: candidate.id }),
        slug: candidate.slug,
        label: candidate.displayName,
      };
    },
  );
  if (!connector) {
    throw new Error(
      `MCP connector "${connectorSlug}" is not authorized for this Agent`,
    );
  }
  return connector;
}
