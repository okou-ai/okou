import { cronOfficialWorkflowCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";
import type { RouteEntry } from "../route-entry";
import { createOfficialWorkflowCatalogSyncCommand } from "../services/official-workflow-catalog-sync.service";
import { upgradeMorningBriefInstallations$ } from "../services/morning-brief-installation-upgrade.service";
import { OFFICIAL_WORKFLOW_SOURCE_CATALOG } from "./official-workflow-catalog-input";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const syncCatalog$ = createOfficialWorkflowCatalogSyncCommand(
  OFFICIAL_WORKFLOW_SOURCE_CATALOG,
);
const syncOfficialWorkflowCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const body = await set(syncCatalog$, signal);
    signal.throwIfAborted();
    if (body.outcome !== "rejected" && body.releaseId !== null) {
      // Repeat on unchanged syncs to catch writes from a draining or rolled-back API.
      await set(upgradeMorningBriefInstallations$, body.releaseId, signal);
    }
    return { status: 200 as const, body };
  },
);

export const cronOfficialWorkflowCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronOfficialWorkflowCatalogContract.sync,
    handler: syncOfficialWorkflowCatalogRoute$,
  },
];
