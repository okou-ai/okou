import chalk from "chalk";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { CustomConnectorReaderResponse as CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connector-readers";
import type { ConnectorCatalogItem } from "../../lib/api/domains/connectors";
import type { ConnectedConnectors } from "@okouai/api-contracts/contracts/connected-connectors";
import type { ConnectorDiscoveryAgentContext } from "./agent-context";
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
  readonly catalogConnector: ConnectorCatalogItem;
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
  catalogConnectors: readonly ConnectorCatalogItem[],
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

export function connectorHasSavedAccounts(
  connector: ConnectorDiscoveryDefinition,
  directory: ConnectedConnectors,
): boolean {
  return connector.kind === "catalog"
    ? directory.builtinConnectors.some((item) => {
        return item.slug === connector.slug;
      })
    : directory.customConnectors.some((item) => {
        return item.id === connector.customConnector.id;
      });
}

export function renderConnectorDiscoveryConnectedAsCell(
  connector: ConnectorDiscoveryItem,
  directory: ConnectedConnectors,
): string {
  return connectorHasSavedAccounts(connector, directory)
    ? "saved accounts (inspect status)"
    : chalk.dim("(no saved accounts)");
}

export function connectorDiscoveryJson(
  connector: ConnectorDiscoveryItem,
  agentContext: ConnectorDiscoveryAgentContext | null,
  directory: ConnectedConnectors,
) {
  const target = connectorDiscoveryTarget(connector);
  return {
    target,
    connectorType: connectorInspectionType(
      target,
      connector.kind === "custom" ? connector.customConnector : null,
    ),
    slug: connector.slug,
    label: connector.label,
    kind: connector.kind === "catalog" ? "builtin" : "custom",
    ...(connector.kind === "custom"
      ? { id: connector.customConnector.id }
      : {}),
    integrationManaged:
      connector.kind === "custom" &&
      isIntegrationManagedCustomConnector(connector.customConnector),
    hasSavedAccounts: connectorHasSavedAccounts(connector, directory),
    authorized: agentContext
      ? isConnectorDiscoveryAuthorized(connector, agentContext)
      : null,
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
