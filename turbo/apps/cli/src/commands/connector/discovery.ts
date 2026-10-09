import chalk from "chalk";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  ConnectorCatalogItem,
  ConnectorCatalogStatus,
} from "../../lib/api/domains/connectors";
import type { ConnectorDiscoveryAgentContext } from "./agent-context";
import { renderConnectedAsCell } from "./connected-as";
import { connectorInspectionType } from "./inspection";

interface CatalogConnectorDiscoveryDefinition {
  readonly kind: "catalog";
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly generation: readonly string[];
  readonly authMethods: ConnectorCatalogItem["authMethods"];
}

interface CatalogConnectorDiscoveryItem extends CatalogConnectorDiscoveryDefinition {
  readonly catalogConnector: ConnectorCatalogStatus;
}

interface CustomConnectorDiscoveryItem {
  readonly kind: "custom";
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly generation: readonly string[];
  readonly authMethods: readonly [];
  readonly customConnector: CustomConnectorResponse;
}

export type ConnectorDiscoveryItem =
  CatalogConnectorDiscoveryItem | CustomConnectorDiscoveryItem;

export type ConnectorDiscoveryDefinition =
  CatalogConnectorDiscoveryDefinition | CustomConnectorDiscoveryItem;

function catalogDiscoveryDefinition(
  connector: ConnectorCatalogItem,
): CatalogConnectorDiscoveryDefinition {
  return {
    kind: "catalog",
    slug: connector.slug,
    label: connector.label,
    description: connector.description,
    category: connector.category,
    tags: connector.tags,
    generation: connector.generation,
    authMethods: connector.authMethods,
  };
}

function customDiscoveryItem(
  connector: CustomConnectorResponse,
): CustomConnectorDiscoveryItem {
  return {
    kind: "custom",
    slug: connector.slug,
    label: connector.displayName,
    description: "",
    category: "custom",
    tags: [],
    generation: [],
    authMethods: [],
    customConnector: connector,
  };
}

export function connectorDiscoveryItems(
  catalogConnectors: readonly ConnectorCatalogStatus[],
  customConnectors: readonly CustomConnectorResponse[],
): readonly ConnectorDiscoveryItem[] {
  return [
    ...catalogConnectors.map((connector): CatalogConnectorDiscoveryItem => {
      return {
        ...catalogDiscoveryDefinition(connector),
        catalogConnector: connector,
      };
    }),
    ...customConnectors.map(customDiscoveryItem),
  ];
}

export function connectorDiscoveryDefinitions(
  catalogConnectors: readonly ConnectorCatalogItem[],
  customConnectors: readonly CustomConnectorResponse[],
): readonly ConnectorDiscoveryDefinition[] {
  return [
    ...catalogConnectors.map(catalogDiscoveryDefinition),
    ...customConnectors.map(customDiscoveryItem),
  ];
}

export function connectorDiscoveryTarget(
  connector: ConnectorDiscoveryDefinition,
): ConnectorAccountTarget {
  return connector.kind === "catalog"
    ? { kind: "builtin", connectorSlug: connector.slug }
    : { kind: "custom", customConnectorId: connector.customConnector.id };
}

export function renderConnectorDiscoveryConnectedAsCell(
  connector: ConnectorDiscoveryItem,
): string {
  if (connector.kind === "catalog") {
    return renderConnectedAsCell(connector.catalogConnector);
  }
  if (connector.customConnector.connected) {
    return chalk.green("connected");
  }
  if (connector.customConnector.missingRequiredFields.length === 0) {
    return chalk.dim("(not connected)");
  }
  return chalk.yellow(
    `missing ${connector.customConnector.missingRequiredFields.join(", ")}`,
  );
}

export function connectorDiscoveryJson(
  connector: ConnectorDiscoveryItem,
  agentContext: ConnectorDiscoveryAgentContext | null,
) {
  const target = connectorDiscoveryTarget(connector);
  const identity = {
    target,
    connectorType: connectorInspectionType(
      target,
      connector.kind === "custom" ? connector.customConnector : null,
    ),
    slug: connector.slug,
    label: connector.label,
    authorized: agentContext
      ? isConnectorDiscoveryAuthorized(connector, agentContext)
      : null,
  };
  return connector.kind === "catalog"
    ? {
        ...identity,
        kind: "builtin" as const,
        connected: connector.catalogConnector.connected,
        connectionStatus: connector.catalogConnector.connectionStatus,
        connection: connector.catalogConnector.connection,
      }
    : {
        ...identity,
        kind: "custom" as const,
        id: connector.customConnector.id,
        connected: connector.customConnector.connected,
        connectionId: connector.customConnector.connectedAccountId ?? null,
        missingRequiredFields: connector.customConnector.missingRequiredFields,
      };
}

export function isConnectorDiscoveryAuthorized(
  connector: ConnectorDiscoveryDefinition,
  agentContext: ConnectorDiscoveryAgentContext,
): boolean {
  if (connector.kind === "catalog") {
    return agentContext.authorizedConnectorSlugs.has(connector.slug);
  }
  return agentContext.authorizedCustomConnectorIds.has(
    connector.customConnector.id,
  );
}
