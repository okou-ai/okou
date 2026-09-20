import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";

export interface ConnectorCatalogConnection {
  readonly response: BuiltinConnectorResponse;
  readonly oauthRequestedScopes: readonly string[] | null;
}
