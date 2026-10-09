import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { syncConnectorCatalog$ } from "../services/connector-catalog-sync.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const syncConnectorCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(syncConnectorCatalog$, signal);
    return {
      status: 200 as const,
      body: { outcome: result.outcome, failureCode: result.failureCode },
    };
  },
);

export const cronConnectorCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronConnectorCatalogContract.sync,
    handler: syncConnectorCatalogRoute$,
  },
];
