import { cronReconcileArtifactCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { reconcileArtifactCatalogFiles$ } from "../services/artifact-catalog.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcileArtifactCatalogRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const body = await set(reconcileArtifactCatalogFiles$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronReconcileArtifactCatalogRoutes: readonly RouteEntry[] = [
  {
    route: cronReconcileArtifactCatalogContract.reconcile,
    handler: reconcileArtifactCatalogRoute$,
  },
];
