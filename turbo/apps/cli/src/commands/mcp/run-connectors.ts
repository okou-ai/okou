import { listRunMcpConnectors as listRunMcpConnectorsApi } from "../../lib/api/domains/connectors";
import { findConnectorBySelector } from "../connector/connector-selector";

type RunMcpConnector = Awaited<
  ReturnType<typeof listRunMcpConnectorsApi>
>[number];

export function listRunMcpConnectors(): Promise<RunMcpConnector[]> {
  return listRunMcpConnectorsApi();
}

export async function resolveRunMcpConnector(
  connectorSlug: string,
): Promise<RunMcpConnector> {
  const connectors = await listRunMcpConnectors();
  const connector = findConnectorBySelector(
    connectors,
    connectorSlug,
    (candidate) => {
      return candidate.target.kind === "builtin"
        ? {
            kind: "builtin",
            slug: candidate.target.connectorSlug,
            label: candidate.displayName,
          }
        : {
            kind: "custom",
            id: candidate.target.customConnectorId,
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
