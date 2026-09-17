import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import type { ConnectorCatalogGeneration } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { reconcileConnectorCatalogCompatibility$ } from "../services/connector-catalog-compatibility.service";
import { connectorCatalogDiagnostics$ } from "../services/connector-catalog-diagnostics.service";
import { reconcileConnectorCatalogRuntimeProjection$ } from "../services/connector-catalog-runtime-projection.service";
import { syncConnectorCatalog$ } from "../services/connector-catalog-sync.service";
import { connectorCatalogServingGeneration } from "../services/connector-catalog-source";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const syncConnectorCatalogGeneration$ = command(
  async (
    { get, set },
    selectedGeneration: ConnectorCatalogGeneration,
    publishRuntimeWakeups: boolean,
    signal: AbortSignal,
  ) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(
      syncConnectorCatalog$,
      selectedGeneration,
      publishRuntimeWakeups,
      signal,
    );
    await set(
      reconcileConnectorCatalogCompatibility$,
      selectedGeneration,
      signal,
    );
    await set(
      reconcileConnectorCatalogRuntimeProjection$,
      selectedGeneration,
      signal,
    );
    const diagnostics = await set(
      connectorCatalogDiagnostics$,
      selectedGeneration,
      signal,
    );
    return {
      status: 200 as const,
      body: {
        outcome: result.outcome,
        ...diagnostics,
      },
    };
  },
);

const syncConnectorCatalogRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await set(
      syncConnectorCatalogGeneration$,
      connectorCatalogServingGeneration(),
      true,
      signal,
    );
  },
);

const warmConnectorCatalogV4Route$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    if (connectorCatalogServingGeneration() === 4) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "CONFLICT",
            message:
              "Catalog v4 is already serving; use the serving sync endpoint",
          },
        },
      };
    }
    return await set(syncConnectorCatalogGeneration$, 4, false, signal);
  },
);

export const cronConnectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronConnectorCatalogContract.sync,
    handler: syncConnectorCatalogRoute$,
  },
  {
    route: cronConnectorCatalogContract.warmV4,
    handler: warmConnectorCatalogV4Route$,
  },
];
