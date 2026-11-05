import type { ConnectorCatalogSyncFailureCode } from "@okouai/api-contracts/contracts/connector-catalog-sync";

export interface ConnectorCatalogSkillFailure {
  readonly code: ConnectorCatalogSyncFailureCode;
  readonly cacheable: boolean;
}

export class ConnectorCatalogSkillError extends Error {
  constructor(readonly failure: ConnectorCatalogSkillFailure) {
    super(failure.code);
    this.name = "ConnectorCatalogSkillError";
  }
}

export function connectorCatalogSkillFailure(
  error: unknown,
): ConnectorCatalogSkillFailure | undefined {
  return error instanceof ConnectorCatalogSkillError
    ? error.failure
    : undefined;
}
