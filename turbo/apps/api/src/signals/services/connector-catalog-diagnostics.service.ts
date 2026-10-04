import type { ConnectorCatalogDiagnostics } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { command } from "ccstate";

import { connectorCatalogCompatibilityStatus$ } from "./connector-catalog-compatibility.service";
import { connectorCatalogStatus$ } from "./connector-catalog-sync.service";
import { loadConnectorCredentialReadiness$ } from "./connector-credential-readiness.service";

export const connectorCatalogDiagnostics$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogDiagnostics> => {
    const status = await set(connectorCatalogStatus$, signal);
    const filtering = await set(
      connectorCatalogCompatibilityStatus$,
      status.active,
      signal,
    );
    const credentialStorage = await set(loadConnectorCredentialReadiness$);
    signal.throwIfAborted();
    return { ...status, filtering, credentialStorage };
  },
);
