import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";

export interface ConnectorCatalogConnection {
  readonly response: BuiltinConnectorResponse;
  readonly oauthRequestedScopes: readonly string[] | null;
  readonly setupStatus?: ConnectorAccountConnection["setupStatus"];
}
