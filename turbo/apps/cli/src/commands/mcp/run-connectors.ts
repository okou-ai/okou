import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { listRunMcpConnectors as listRunMcpConnectorsApi } from "../../lib/api/domains/connectors";
import { findConnectorBySelector } from "../connector/connector-selector";
import { chatConnectorAccountsEnabled } from "../../lib/api/domains/run-connector-accounts";

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
      chatConnectorAccountsEnabled()
        ? `MCP connector "${connectorSlug}" has no available account in this Chat`
        : `MCP connector "${connectorSlug}" is not authorized for this ${decodeSandboxTokenPayload()?.singleAgent ? "Run" : "Agent"}`,
    );
  }
  return connector;
}
