import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";

import { orderByCustomConnectorId } from "./custom-connector-order";

export interface CustomConnectorDefinitionVersion {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly isMcp: boolean;
}

export interface AgentConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}

export interface AgentConnectorScopeSnapshot extends AgentConnectorScope {
  readonly customConnectorDefinitions: readonly CustomConnectorDefinitionVersion[];
}

export interface AgentConnectorSlugRow {
  readonly connectorSlug: string;
}

export interface AgentCustomConnectorRow {
  readonly customConnectorId: string;
  readonly connectorSlug: string;
  readonly storageVersion: number;
  readonly skillStorageVersionId: string | null;
  readonly isMcp: boolean;
}

export function agentConnectorScopeFromRows(args: {
  readonly connectorRows: readonly AgentConnectorSlugRow[];
  readonly customConnectorRows: readonly AgentCustomConnectorRow[];
}): AgentConnectorScopeSnapshot {
  const allowedConnectorSlugs = args.connectorRows
    .flatMap((row) => {
      const parsed = connectorSlugSchema.safeParse(row.connectorSlug);
      return parsed.success ? [parsed.data] : [];
    })
    .sort();
  const customConnectorRows = orderByCustomConnectorId(
    args.customConnectorRows,
    (row) => {
      return row.customConnectorId;
    },
  );
  const allowedCustomConnectorIds = customConnectorRows.map((row) => {
    return row.customConnectorId;
  });
  const customConnectorDefinitions = customConnectorRows.map((row) => {
    return {
      customConnectorId: row.customConnectorId,
      connectorSlug: row.connectorSlug,
      storageVersion: row.storageVersion,
      skillStorageVersionId: row.skillStorageVersionId,
      isMcp: row.isMcp,
    };
  });
  return {
    allowedConnectorSlugs,
    allowedCustomConnectorIds,
    customConnectorDefinitions,
  };
}
