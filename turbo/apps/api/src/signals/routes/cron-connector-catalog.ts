import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { env } from "../../lib/env";
import type { RouteEntry } from "../route-entry";
import { seedPreviewConnectorCatalog$ } from "../services/preview-connector-catalog.service";
import { reconcileConnectorCatalogCompatibility$ } from "../services/connector-catalog-compatibility.service";
import { connectorCatalogDiagnostics$ } from "../services/connector-catalog-diagnostics.service";
import { syncConnectorCatalog$ } from "../services/connector-catalog-sync.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const syncConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(syncConnectorCatalog$, signal);
    await set(reconcileConnectorCatalogCompatibility$, signal);
    const diagnostics = await set(connectorCatalogDiagnostics$, signal);
    return {
      status: 200 as const,
      body: {
        outcome: result.outcome,
        ...diagnostics,
      },
    };
  },
);

const seedPreviewConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    if (env("ENV") !== "preview") {
      return {
        status: 404 as const,
        body: { error: { code: "NOT_FOUND", message: "Not found" } },
      };
    }
    return {
      status: 200 as const,
      body: await set(seedPreviewConnectorCatalog$, signal),
    };
  },
);

export const cronConnectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronConnectorCatalogContract.seedPreview,
    handler: seedPreviewConnectorCatalogRoute$,
  },
  {
    route: cronConnectorCatalogContract.sync,
    handler: syncConnectorCatalogRoute$,
  },
];
