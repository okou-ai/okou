import chalk from "chalk";
import type {
  ConnectorAccountSummary,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { CustomConnectorReaderResponse as CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connector-readers";
import type {
  ConnectorCatalogItem,
  ConnectorCatalogStatus,
} from "../../lib/api/domains/connectors";
import type { ConnectorDiscoveryAgentContext } from "./agent-context";
import { connectorInspectionType } from "./inspection";
import {
  memberConnectorAccountText,
  memberConnectorFacts,
} from "./member-status";

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
  summaries: ReadonlyMap<string, ConnectorAccountSummary>,
): string {
  const definition =
    connector.kind === "catalog"
      ? connector.catalogConnector
      : connector.customConnector;
  const facts = memberConnectorFacts(definition, summaries);
  const text = memberConnectorAccountText(definition, facts);
  return facts.memberStatus === "connected" ? text : chalk.yellow(text);
}

export function connectorDiscoveryJson(
  connector: ConnectorDiscoveryItem,
  agentContext: ConnectorDiscoveryAgentContext | null,
  summaries: ReadonlyMap<string, ConnectorAccountSummary>,
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
    ...memberConnectorFacts(
      connector.kind === "catalog"
        ? connector.catalogConnector
        : connector.customConnector,
      summaries,
    ),
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
        missingRequiredFields: connector.customConnector.missingRequiredFields,
        configuredFieldKeys: connector.customConnector.configuredFieldKeys,
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
