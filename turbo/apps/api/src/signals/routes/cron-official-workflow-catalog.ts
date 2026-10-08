import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { createOfficialWorkflowCatalogSyncCommand } from "../services/official-workflow-catalog-sync.service";
import { OFFICIAL_WORKFLOW_SOURCE_CATALOG } from "../services/official-workflow-catalog-source";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

export function createCronOfficialWorkflowCatalogRoutes(
  candidate: unknown,
): readonly RouteEntry[] {
  const syncCommand = createOfficialWorkflowCatalogSyncCommand(candidate);
  const syncOfficialWorkflowCatalogRoute$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!get(hasValidCronSecret$)) {
        return cronUnauthorized();
      }
      return {
        status: 200 as const,
        body: await set(syncCommand, signal),
      };
    },
  );
  return [
    {
      route: cronOfficialWorkflowCatalogContract.sync,
      handler: syncOfficialWorkflowCatalogRoute$,
    },
  ];
}

export const cronOfficialWorkflowCatalogRoutes =
  createCronOfficialWorkflowCatalogRoutes(OFFICIAL_WORKFLOW_SOURCE_CATALOG);
