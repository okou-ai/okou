import type { ConnectorCatalogDiagnostics } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { command } from "ccstate";
import type { ConnectorCatalogGeneration } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

import { db$ } from "../external/db";
import { connectorCatalogCompatibilityStatus$ } from "./connector-catalog-compatibility.service";
import { connectorCatalogStatus$ } from "./connector-catalog-sync.service";
import { loadConnectorCredentialReadiness } from "./connector-credential-readiness.service";

export const connectorCatalogDiagnostics$ = command(
  async (
    { get, set },
    generation: ConnectorCatalogGeneration,
    signal: AbortSignal,
  ): Promise<ConnectorCatalogDiagnostics> => {
    const status = await set(connectorCatalogStatus$, generation, signal);
    const filtering = await set(
      connectorCatalogCompatibilityStatus$,
      status.active,
      generation,
      signal,
    );
    const credentialStorage = await loadConnectorCredentialReadiness(get(db$));
    signal.throwIfAborted();
    return { ...status, filtering, credentialStorage };
  },
);
