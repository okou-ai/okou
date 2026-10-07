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
    // Pointer, filtering and storage readiness are the staff diagnostics. The
    // writer's report of the attempt it just made (state, active identity and
    // history) comes from its own sync state and leaves with it in Release 2.
    return {
      status: 200 as const,
      body: {
        ...diagnostics,
        outcome: result.outcome,
        state: result.state,
        active: result.active,
        lastAttempt: result.lastAttempt,
        lastSuccessAt: result.lastSuccessAt,
        rejectedCandidate: result.rejectedCandidate,
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
